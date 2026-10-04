"""Remote data sources: geocoding, population (Census blocks / HRSL / Kontur) and roads (OSM).

Every fetch here is wrapped by the on-disk cache in server.py; nothing is
downloaded twice for the same city extent.
"""
from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request

import numpy as np

from tiff_window import RemoteTiff, UA

NOMINATIM = "https://nominatim.openstreetmap.org/search"
TIGER_BLOCKS = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/tigerWMS_Census2020/MapServer/10/query"
HRSL_BASE = "https://dataforgood-fb-data.s3.amazonaws.com/hrsl-cogs/hrsl_general/"
OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# road classes, in order of the class index sent to the browser
ROAD_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "residential"]
_ROAD_MAP = {
    "motorway": 0, "motorway_link": 0, "trunk": 1, "trunk_link": 1,
    "primary": 2, "primary_link": 2, "secondary": 3, "secondary_link": 3,
    "tertiary": 4, "tertiary_link": 4, "residential": 5, "unclassified": 5,
    "living_street": 5,
}

_last_nominatim = [0.0]


def _get_json(url: str, data: bytes | None = None, timeout: int = 180):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------- geocoding

def geocode(q: str) -> list[dict]:
    # Nominatim usage policy: max 1 request/second, identifying User-Agent.
    wait = 1.1 - (time.time() - _last_nominatim[0])
    if wait > 0:
        time.sleep(wait)
    _last_nominatim[0] = time.time()
    url = NOMINATIM + "?" + urllib.parse.urlencode(
        {"q": q, "format": "jsonv2", "limit": 8, "addressdetails": 1, "featureType": "settlement"})
    res = _get_json(url)
    out = []
    for r in res:
        bb = [float(x) for x in r["boundingbox"]]  # S, N, W, E
        lat, lon = float(r["lat"]), float(r["lon"])
        kx = 111.320 * math.cos(math.radians(lat))
        half_w = (bb[3] - bb[2]) * kx / 2
        half_h = (bb[1] - bb[0]) * 110.574 / 2
        out.append({
            "name": r.get("name") or r["display_name"].split(",")[0],
            "display": r["display_name"],
            "lat": lat, "lon": lon,
            "country": (r.get("address", {}).get("country_code") or "").lower(),
            "suggestedRadiusKm": round(min(30.0, max(4.0, max(half_w, half_h))), 1),
            "type": r.get("addresstype") or r.get("type"),
        })
    return out


# ---------------------------------------------------------------- extent helpers

class Extent:
    """Square extent of half-width R km around (lat0, lon0) in a local
    equirectangular projection: x east, y north, metres."""

    def __init__(self, lat0: float, lon0: float, radius_km: float):
        self.lat0, self.lon0, self.R = lat0, lon0, radius_km * 1000.0
        self.kx = 111320.0 * math.cos(math.radians(lat0))
        self.ky = 110574.0

    @property
    def bbox(self):  # (lat_min, lat_max, lon_min, lon_max)
        dlat = self.R / self.ky
        dlon = self.R / self.kx
        return self.lat0 - dlat, self.lat0 + dlat, self.lon0 - dlon, self.lon0 + dlon

    def xy(self, lat, lon):
        return (np.asarray(lon) - self.lon0) * self.kx, (np.asarray(lat) - self.lat0) * self.ky


# ---------------------------------------------------------------- US Census blocks

def fetch_census_blocks(ext: Extent, progress=lambda msg: None) -> dict:
    """2020 Decennial Census blocks intersecting the extent.
    Returns arrays of internal-point lat/lon, POP100, AREALAND, AREAWATER."""
    lat_min, lat_max, lon_min, lon_max = ext.bbox
    base = {
        "where": "1=1",
        "geometry": f"{lon_min},{lat_min},{lon_max},{lat_max}",
        "geometryType": "esriGeometryEnvelope", "inSR": "4326",
        "spatialRel": "esriSpatialRelIntersects",
        "outFields": "POP100,INTPTLAT,INTPTLON,AREALAND,AREAWATER",
        "returnGeometry": "false", "orderByFields": "OBJECTID", "f": "json",
    }
    total = _get_json(TIGER_BLOCKS + "?" + urllib.parse.urlencode({**base, "returnCountOnly": "true"}))["count"]
    page = 25000
    lat, lon, pop, aland, awater = [], [], [], [], []
    offset = 0
    while offset < total:
        progress(f"Census blocks {offset:,}/{total:,}")
        q = {**base, "resultOffset": offset, "resultRecordCount": page}
        for attempt in range(4):
            try:
                res = _get_json(TIGER_BLOCKS + "?" + urllib.parse.urlencode(q), timeout=300)
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 + 3 * attempt)
        feats = res.get("features", [])
        if not feats:
            break
        for f in feats:
            a = f["attributes"]
            lat.append(float(a["INTPTLAT"]))
            lon.append(float(a["INTPTLON"]))
            pop.append(float(a["POP100"] or 0))
            aland.append(float(a["AREALAND"] or 0))
            awater.append(float(a["AREAWATER"] or 0))
        offset += len(feats)
    progress(f"Census blocks {len(pop):,}/{total:,}")
    return {"lat": np.array(lat), "lon": np.array(lon), "pop": np.array(pop),
            "aland": np.array(aland), "awater": np.array(awater)}


def grid_census(blocks: dict, ext: Extent, cell_m: float):
    """Aggregate blocks to the grid. Blocks larger than a cell are spread over a
    disk of equal area (sunflower sampling) so large rural/water blocks don't
    dump everything into one cell."""
    n = int(math.ceil(2 * ext.R / cell_m))
    pop = np.zeros((n, n))
    land = np.zeros((n, n))
    water = np.zeros((n, n))
    x, y = ext.xy(blocks["lat"], blocks["lon"])
    area = blocks["aland"] + blocks["awater"]
    r_eq = np.sqrt(area / math.pi)
    small = r_eq < cell_m * 0.3

    def deposit(xs, ys, p, al, aw):
        col = np.floor((xs + ext.R) / cell_m).astype(int)
        row = np.floor((ext.R - ys) / cell_m).astype(int)
        ok = (col >= 0) & (col < n) & (row >= 0) & (row < n)
        np.add.at(pop, (row[ok], col[ok]), p[ok])
        np.add.at(land, (row[ok], col[ok]), al[ok])
        np.add.at(water, (row[ok], col[ok]), aw[ok])

    deposit(x[small], y[small], blocks["pop"][small], blocks["aland"][small], blocks["awater"][small])
    golden = math.pi * (3 - math.sqrt(5))
    for i in np.nonzero(~small)[0]:
        k = int(min(2000, max(4, math.ceil(4 * (r_eq[i] / cell_m) ** 2))))
        j = np.arange(k)
        rr = r_eq[i] * np.sqrt((j + 0.5) / k)
        th = j * golden
        xs = x[i] + rr * np.cos(th)
        ys = y[i] + rr * np.sin(th)
        deposit(xs, ys, np.full(k, blocks["pop"][i] / k), np.full(k, blocks["aland"][i] / k),
                np.full(k, blocks["awater"][i] / k))
    # Land fraction = land share of the block area that landed in the cell.
    # Cells never touched by any block (e.g. across an international border or
    # far offshore) have no data: treated as unpopulated and impassable.
    tot = land + water
    land_frac = np.where(tot > 0, land / np.maximum(tot, 1e-9), 0.0)
    return pop, land_frac


# ---------------------------------------------------------------- Meta HRSL (30 m)

def hrsl_sources(vrt_text: str, ext: "Extent"):
    """COG tiles of the HRSL mosaic that intersect the extent."""
    import re
    gt = [float(x) for x in re.search(r"<GeoTransform>([^<]*)", vrt_text).group(1).split(",")]
    lat_min, lat_max, lon_min, lon_max = ext.bbox
    out = []
    for f, x, y, w, h in re.findall(
            r'<SourceFilename[^>]*>([^<]*)</SourceFilename>.*?<DstRect xOff="([\d.]+)" yOff="([\d.]+)" '
            r'xSize="([\d.]+)" ySize="([\d.]+)"', vrt_text, re.S):
        x, y, w, h = map(float, (x, y, w, h))
        lo0 = gt[0] + x * gt[1]
        la0 = gt[3] + y * gt[5]
        lo1 = lo0 + w * gt[1]
        la1 = la0 + h * gt[5]
        if lo0 < lon_max and lo1 > lon_min and la1 < lat_max and la0 > lat_min:
            out.append(HRSL_BASE + f)
    return out


def fetch_hrsl(ext: "Extent", vrt_text: str, progress=lambda msg: None):
    """Mosaic the HRSL window at native 1 arc-second; None if no coverage.
    Returned array: people per pixel, NaN = no settlement detected."""
    urls = hrsl_sources(vrt_text, ext)
    if not urls:
        return None
    lat_min, lat_max, lon_min, lon_max = ext.bbox
    res = 1.0 / 3600.0
    rows = int(round((lat_max - lat_min) / res)) + 2
    cols = int(round((lon_max - lon_min) / res)) + 2
    mosaic = np.full((rows, cols), np.nan, dtype=np.float32)
    lat_top, lon_left = lat_max, lon_min
    for i, u in enumerate(urls):
        progress(f"Downloading Meta HRSL 30 m tiles ({i + 1}/{len(urls)})")
        t = RemoteTiff(u)
        try:
            arr, lt, ll = t.read_window(lat_min, lat_max, lon_min, lon_max)
        except ValueError:
            continue
        r0 = int(round((lat_top - lt) / res))
        c0 = int(round((ll - lon_left) / res))
        rr0, cc0 = max(r0, 0), max(c0, 0)
        rr1, cc1 = min(r0 + arr.shape[0], rows), min(c0 + arr.shape[1], cols)
        if rr1 <= rr0 or cc1 <= cc0:
            continue
        sub = arr[rr0 - r0:rr1 - r0, cc0 - c0:cc1 - c0]
        tgt = mosaic[rr0:rr1, cc0:cc1]
        m = ~np.isnan(sub)
        tgt[m] = sub[m]
    if np.all(np.isnan(mosaic)):
        return None
    return {"arr": mosaic, "lat_top": lat_top, "lon_left": lon_left, "sx": res, "sy": res,
            "url": ";".join(u.rsplit("/", 1)[-1] for u in urls)}


# ---------------------------------------------------------------- Kontur (H3, 400 m)

KONTUR_URL = "https://geodata-eu-central-1-kontur-public.s3.amazonaws.com/kontur_datasets/kontur_population_{cc}_20231101.gpkg.gz"
_WEBM = 6378137.0


def kontur_gpkg(country2: str, cache_dir, progress=lambda msg: None):
    """Download (once) and decompress the Kontur country GeoPackage."""
    import gzip, shutil
    cc = country2.upper()
    path = cache_dir / f"kontur_{cc}.gpkg"
    if path.exists():
        return path
    progress(f"Downloading Kontur population for {cc} (one-time, country-wide file)")
    req = urllib.request.Request(KONTUR_URL.format(cc=cc), headers={"User-Agent": UA})
    tmp = path.with_suffix(".tmp")
    with urllib.request.urlopen(req, timeout=900) as r, gzip.GzipFile(fileobj=r) as gz, open(tmp, "wb") as f:
        shutil.copyfileobj(gz, f, 1 << 20)
    tmp.replace(path)
    return path


def fetch_kontur(ext: Extent, gpkg_path, progress=lambda msg: None):
    """Kontur H3 resolution-8 hexagons (~0.74 km²) intersecting the extent,
    returned as sample points (24 per hexagon, spread over its six triangles)."""
    import sqlite3, struct
    lat_min, lat_max, lon_min, lon_max = ext.bbox
    to_x = lambda lon: math.radians(lon) * _WEBM
    to_y = lambda lat: _WEBM * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))
    x0, x1, y0, y1 = to_x(lon_min), to_x(lon_max), to_y(lat_min), to_y(lat_max)
    progress("Scanning Kontur hexagons for this extent")
    con = sqlite3.connect(str(gpkg_path))
    table = con.execute("select table_name from gpkg_contents").fetchone()[0]
    # 4 triangle sample positions (barycentric) repeated over the 6 fan triangles
    bary = [(1 / 6, 1 / 6), (2 / 3, 1 / 6), (1 / 6, 2 / 3), (1 / 3, 1 / 3)]
    xs, ys, ws = [], [], []
    for geom, pop in con.execute(f"select geom, population from {table}"):
        flags = geom[3]
        env = (flags >> 1) & 7
        if env:
            minx, maxx, miny, maxy = struct.unpack_from("<4d" if flags & 1 else ">4d", geom, 8)
            if maxx < x0 or minx > x1 or maxy < y0 or miny > y1:
                continue
        off = 8 + {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]
        bo = "<" if geom[off] == 1 else ">"
        nrings, npts = struct.unpack_from(bo + "II", geom, off + 5)
        pts = struct.unpack_from(bo + f"{2 * npts}d", geom, off + 13)
        vx, vy = pts[0:2 * npts - 2:2], pts[1:2 * npts - 2:2]  # drop closing vertex
        cx, cy = sum(vx) / len(vx), sum(vy) / len(vy)
        k = len(vx)
        w = pop / (k * len(bary))
        for t in range(k):
            ax, ay, bx, by = vx[t], vy[t], vx[(t + 1) % k], vy[(t + 1) % k]
            for u, v in bary:
                xs.append(cx + u * (ax - cx) + v * (bx - cx))
                ys.append(cy + u * (ay - cy) + v * (by - cy))
                ws.append(w)
    con.close()
    if not ws:
        return None
    xs, ys = np.array(xs), np.array(ys)
    lon = np.degrees(xs / _WEBM)
    lat = np.degrees(2 * np.arctan(np.exp(ys / _WEBM)) - math.pi / 2)
    return {"lat": lat, "lon": lon, "w": np.array(ws), "url": gpkg_path.name}


def grid_points(pts: dict, ext: Extent, cell_m: float, n: int):
    x, y = ext.xy(pts["lat"], pts["lon"])
    col = np.floor((x + ext.R) / cell_m).astype(int)
    row = np.floor((ext.R - y) / cell_m).astype(int)
    ok = (col >= 0) & (col < n) & (row >= 0) & (row < n)
    pop = np.zeros((n, n))
    np.add.at(pop, (row[ok], col[ok]), pts["w"][ok])
    return pop


def grid_raster(wp: dict, ext: Extent, cell_m: float, n: int | None = None):
    n = n or int(math.ceil(2 * ext.R / cell_m))
    arr = wp["arr"]
    rows, cols = arr.shape
    lat = wp["lat_top"] - (np.arange(rows) + 0.5) * wp["sy"]
    lon = wp["lon_left"] + (np.arange(cols) + 0.5) * wp["sx"]
    LON, LAT = np.meshgrid(lon, lat)
    x, y = ext.xy(LAT, LON)
    col = np.floor((x + ext.R) / cell_m).astype(int).ravel()
    row = np.floor((ext.R - y) / cell_m).astype(int).ravel()
    ok = (col >= 0) & (col < n) & (row >= 0) & (row < n)
    vals = arr.ravel()
    valid = ~np.isnan(vals)
    pop = np.zeros((n, n))
    cnt = np.zeros((n, n))
    vcnt = np.zeros((n, n))
    np.add.at(pop, (row[ok & valid], col[ok & valid]), vals[ok & valid])
    np.add.at(cnt, (row[ok], col[ok]), 1)
    np.add.at(vcnt, (row[ok & valid], col[ok & valid]), 1)
    land = np.where(cnt > 0, vcnt / np.maximum(cnt, 1), 0.0)
    return pop, land


# ---------------------------------------------------------------- OSM roads & places

def fetch_osm(ext: Extent, detail: str, progress=lambda msg: None) -> dict:
    lat_min, lat_max, lon_min, lon_max = ext.bbox
    bb = f"{lat_min},{lon_min},{lat_max},{lon_max}"
    hw = "motorway|trunk|primary|secondary|tertiary"
    if detail == "all":
        hw += "|residential|unclassified|living_street"
    q = f"""[out:json][timeout:300];
(
  way["highway"~"^({hw})(_link)?$"]({bb});
);
out geom qt;
node["place"~"^(borough|suburb|quarter|neighbourhood|city|town|village)$"]["name"]({bb});
out qt;"""
    last = None
    for ep in OVERPASS:
        progress(f"Downloading OpenStreetMap roads ({detail}) from {urllib.parse.urlparse(ep).netloc}")
        try:
            res = _get_json(ep, data=urllib.parse.urlencode({"data": q}).encode(), timeout=360)
            break
        except Exception as e:  # try the next mirror
            last = e
    else:
        raise RuntimeError(f"all Overpass mirrors failed: {last}")
    ways, places = [], []
    for el in res.get("elements", []):
        if el["type"] == "way" and "geometry" in el:
            c = _ROAD_MAP.get(el.get("tags", {}).get("highway", ""))
            if c is None:
                continue
            pts = []
            for g in el["geometry"]:
                pts += [g["lat"], g["lon"]]
            ways.append({"c": c, "p": pts, "b": 1 if el["tags"].get("bridge") not in (None, "no") else 0})
        elif el["type"] == "node":
            t = el.get("tags", {})
            places.append({"name": t.get("name"), "kind": t.get("place"), "lat": el["lat"], "lon": el["lon"]})
    return {"ways": ways, "places": places}


def fetch_water(ext: Extent, progress=lambda msg: None) -> dict:
    """Water polygons (lakes, rivers, bays) and coastlines for the land mask."""
    lat_min, lat_max, lon_min, lon_max = ext.bbox
    bb = f"{lat_min},{lon_min},{lat_max},{lon_max}"
    q = f"""[out:json][timeout:300];
(
  way["natural"="water"]({bb});
  way["waterway"="riverbank"]({bb});
  way["natural"="bay"]({bb});
  rel["natural"="water"]({bb});
  rel["waterway"="riverbank"]({bb});
  rel["natural"="bay"]({bb});
);
out geom qt;
way["natural"="coastline"]({bb});
out geom qt;"""
    last = None
    for ep in OVERPASS:
        progress(f"Downloading OpenStreetMap water & coastline from {urllib.parse.urlparse(ep).netloc}")
        try:
            res = _get_json(ep, data=urllib.parse.urlencode({"data": q}).encode(), timeout=360)
            break
        except Exception as e:
            last = e
    else:
        raise RuntimeError(f"all Overpass mirrors failed: {last}")
    areas, coast = [], []
    for el in res.get("elements", []):
        tags = el.get("tags", {})
        if el["type"] == "way" and "geometry" in el:
            seg = [[g["lat"], g["lon"]] for g in el["geometry"]]
            if tags.get("natural") == "coastline":
                coast.append(seg)
            else:
                areas.append([seg])
        elif el["type"] == "relation":
            segs = []
            for m in el.get("members", []):
                if m.get("type") == "way" and m.get("geometry") and m.get("role") in ("outer", "inner", ""):
                    segs.append([[g["lat"], g["lon"]] for g in m["geometry"] if g])
            if segs:
                areas.append(segs)
    return {"areas": areas, "coast": coast}
