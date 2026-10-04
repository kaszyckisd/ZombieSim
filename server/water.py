"""Land/water mask from OpenStreetMap water polygons and coastlines.

Used for sources without a land mask of their own (HRSL marks "no buildings",
not "water"). Rasterised on a sub-grid (4x the simulation resolution) and
reduced to a per-cell land fraction.

* Water areas (natural=water, waterway=riverbank, multipolygon relations) are
  filled with an even-odd scanline rasteriser; multipolygon inner rings
  (islands) are subtracted automatically by the even-odd rule.
* Sea: OSM coastlines are directed with land on the left. They are drawn as a
  4-connected barrier, cells just to the right of each segment seed a flood
  fill, and the flood is confined to unpopulated cells so a bad seed can never
  drown a neighbourhood.
"""
from __future__ import annotations

import numpy as np

SUB = 4  # sub-grid factor


def _to_sub(ext, lat, lon, cell_m):
    x, y = ext.xy(np.asarray(lat), np.asarray(lon))
    sc = cell_m / SUB
    return (x + ext.R) / sc, (ext.R - y) / sc  # fractional (col, row)


def _assemble_rings(segments):
    """Join open way geometries into closed rings by matching endpoints."""
    rings, open_ = [], []
    for s in segments:
        if len(s) < 2:
            continue
        if s[0] == s[-1]:
            rings.append(s)
        else:
            open_.append(list(s))
    while open_:
        cur = open_.pop()
        changed = True
        while changed and cur[0] != cur[-1]:
            changed = False
            for i, o in enumerate(open_):
                if o[0] == cur[-1]:
                    cur += o[1:]
                elif o[-1] == cur[-1]:
                    cur += o[::-1][1:]
                elif o[-1] == cur[0]:
                    cur = o[:-1] + cur
                elif o[0] == cur[0]:
                    cur = o[::-1][:-1] + cur
                else:
                    continue
                open_.pop(i)
                changed = True
                break
        rings.append(cur)  # force-closed below if still open
    return rings


def _fill_rings(rings_xy, H, W):
    """Even-odd fill of a set of rings (each (cols, rows) float arrays)."""
    diff = np.zeros((H, W + 1), dtype=np.int32)
    rows_all, xs_all = [], []
    for cx, cy in rings_xy:
        if len(cx) < 3:
            continue
        x1, y1 = cx, cy
        x2, y2 = np.roll(cx, -1), np.roll(cy, -1)
        lo = np.minimum(y1, y2)
        hi = np.maximum(y1, y2)
        # pixel-centre rows r+0.5 with lo <= r+0.5 < hi
        r0 = np.ceil(lo - 0.5).astype(int)
        r1 = np.ceil(hi - 0.5).astype(int) - 1
        r0c = np.maximum(r0, 0)
        r1c = np.minimum(r1, H - 1)
        cnt = np.maximum(r1c - r0c + 1, 0)
        if cnt.sum() == 0:
            continue
        e = np.repeat(np.arange(len(cx)), cnt)
        offs = np.arange(cnt.sum()) - np.repeat(np.cumsum(cnt) - cnt, cnt)
        rows = r0c[e] + offs
        yc = rows + 0.5
        t = (yc - y1[e]) / (y2[e] - y1[e])
        xs = x1[e] + t * (x2[e] - x1[e])
        # crossings above/below the window still matter for parity: they don't,
        # because parity is evaluated per row and rows outside are skipped.
        rows_all.append(rows)
        xs_all.append(xs)
    if not rows_all:
        return np.zeros((H, W), dtype=bool)
    rows = np.concatenate(rows_all)
    xs = np.concatenate(xs_all)
    order = np.lexsort((xs, rows))
    rows, xs = rows[order], xs[order]
    # pair consecutive crossings within each row
    starts = np.r_[0, np.nonzero(np.diff(rows))[0] + 1]
    rank = np.arange(len(rows)) - np.repeat(starts, np.diff(np.r_[starts, len(rows)]))
    a = rank % 2 == 0
    b = np.r_[a[1:], False] & (np.r_[rows[1:], -1] == rows)
    pa = np.nonzero(a & b)[0]
    ra = rows[pa]
    ca = np.clip(np.ceil(xs[pa] - 0.5).astype(int), 0, W)
    cb = np.clip(np.ceil(xs[pa + 1] - 0.5).astype(int), 0, W)
    np.add.at(diff, (ra, ca), 1)
    np.add.at(diff, (ra, cb), -1)
    return (np.cumsum(diff, axis=1)[:, :W] % 2) == 1


def _draw_lines(mask, cx, cy):
    """4-connected polyline rasterisation (no diagonal gaps for flood fill)."""
    H, W = mask.shape
    for i in range(len(cx) - 1):
        x0, y0, x1, y1 = cx[i], cy[i], cx[i + 1], cy[i + 1]
        n = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 2
        t = np.linspace(0, 1, n)
        xs = np.floor(x0 + t * (x1 - x0)).astype(int)
        ys = np.floor(y0 + t * (y1 - y0)).astype(int)
        # add the elbow cell between diagonal steps
        ex = np.r_[xs, xs[1:]]
        ey = np.r_[ys, ys[:-1]]
        ok = (ex >= 0) & (ex < W) & (ey >= 0) & (ey < H)
        mask[ey[ok], ex[ok]] = True


def land_fraction(ext, cell_m, water_osm, pop_sub):
    """pop_sub: population on the (n*SUB)^2 sub-grid."""
    H = W = pop_sub.shape[0]
    n = H // SUB
    water = np.zeros((H, W), dtype=bool)

    # ---- polygons
    for feat in water_osm.get("areas", []):
        rings = _assemble_rings([[tuple(p) for p in seg] for seg in feat])
        rings_xy = []
        for r in rings:
            arr = np.array(r)
            cx, cy = _to_sub(ext, arr[:, 0], arr[:, 1], cell_m)
            rings_xy.append((cx, cy))
        water |= _fill_rings(rings_xy, H, W)

    # ---- sea from coastlines
    coast = water_osm.get("coast", [])
    if coast:
        barrier = np.zeros((H, W), dtype=bool)
        seeds = np.zeros((H, W), dtype=bool)
        for seg in coast:
            arr = np.array(seg)
            cx, cy = _to_sub(ext, arr[:, 0], arr[:, 1], cell_m)
            _draw_lines(barrier, cx, cy)
            # right-hand normal in (col,row) space; rows grow southward so the
            # geographic "right" of travel is (dy, -dx) with row flipped.
            dx = np.diff(cx)
            dy = np.diff(cy)
            L = np.hypot(dx, dy) + 1e-9
            mx = (cx[:-1] + cx[1:]) / 2
            my = (cy[:-1] + cy[1:]) / 2
            # direction in geographic coords: (dx, -dy); right normal = (-dy', ... )
            # with u = (dx, -dy) (east, north), right = (u_n, -u_e) = (-dy, -dx)
            # back to (col,row): col += -dy, row -= -dx  => row += dx
            sx = np.floor(mx + (-dy / L) * 1.5).astype(int)
            sy = np.floor(my + (dx / L) * 1.5).astype(int)
            ok = (sx >= 0) & (sx < W) & (sy >= 0) & (sy < H)
            seeds[sy[ok], sx[ok]] = True
        # flood confined to sub-cells of unpopulated (<25 /km^2) cells
        dens = pop_sub / (cell_m / SUB / 1000.0) ** 2
        empty = dens < 50
        allowed = empty & ~barrier
        sea = seeds & allowed
        for _ in range(4 * H):
            grown = sea.copy()
            grown[1:, :] |= sea[:-1, :]
            grown[:-1, :] |= sea[1:, :]
            grown[:, 1:] |= sea[:, :-1]
            grown[:, :-1] |= sea[:, 1:]
            grown &= allowed
            if np.array_equal(grown, sea):
                break
            sea = grown
        # sanity: if "sea" swallowed most populated land the winding was wrong
        water |= sea | (barrier & empty)

    wf = water.reshape(n, SUB, n, SUB).mean(axis=(1, 3))
    return 1.0 - wf
