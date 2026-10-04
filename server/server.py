#!/usr/bin/env python3
"""ZombieSim local data server.

Serves the web UI and prepares per-city data bundles (population grid, land
mask, road network, place names). All downloads are cached under ../cache so a
city only has to be fetched once.

    python3 server/server.py [--port 8765]
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import mimetypes
import os
import threading
import time
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

import sources
import water as water_mod
from sources import Extent

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CACHE = ROOT / "cache"
for sub in ("geocode", "population", "osm", "bundles"):
    (CACHE / sub).mkdir(parents=True, exist_ok=True)

PRESETS = [
    # name, country, lat, lon, radius km
    ("New York City", "us", 40.7306, -73.9352, 22), ("Los Angeles", "us", 34.0522, -118.2437, 28),
    ("Chicago", "us", 41.8500, -87.6800, 20), ("Houston", "us", 29.7604, -95.3698, 25),
    ("Phoenix", "us", 33.4484, -112.0740, 25), ("Philadelphia", "us", 39.9800, -75.1400, 16),
    ("San Francisco", "us", 37.7749, -122.4194, 12), ("Seattle", "us", 47.6062, -122.3321, 15),
    ("Boston", "us", 42.3401, -71.0800, 14), ("Washington, DC", "us", 38.9072, -77.0369, 15),
    ("Atlanta", "us", 33.7490, -84.3880, 20), ("Miami", "us", 25.7617, -80.1918, 16),
    ("Denver", "us", 39.7392, -104.9903, 18), ("New Orleans", "us", 29.9511, -90.0715, 14),
    ("Pittsburgh", "us", 40.4406, -79.9959, 12), ("Minneapolis", "us", 44.9778, -93.2650, 15),
    ("London", "gb", 51.5074, -0.1278, 25), ("Paris", "fr", 48.8566, 2.3522, 16),
    ("Berlin", "de", 52.5200, 13.4050, 20), ("Rome", "it", 41.9028, 12.4964, 16),
    ("Madrid", "es", 40.4168, -3.7038, 16), ("Tokyo", "jp", 35.6812, 139.7671, 25),
    ("Seoul", "kr", 37.5665, 126.9780, 20), ("Mumbai", "in", 19.0760, 72.8777, 18),
    ("Lagos", "ng", 6.5244, 3.3792, 20), ("Cairo", "eg", 30.0444, 31.2357, 20),
    ("São Paulo", "br", -23.5505, -46.6333, 25), ("Mexico City", "mx", 19.4326, -99.1332, 25),
    ("Toronto", "ca", 43.6532, -79.3832, 20), ("Sydney", "au", -33.8688, 151.2093, 25),
    ("Istanbul", "tr", 41.0082, 28.9784, 25),
]

JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
FETCH_LOCK = threading.Lock()  # one remote fetch at a time: be polite to public APIs


def _key(*parts) -> str:
    return "_".join(str(p) for p in parts).replace(" ", "").replace("/", "-")


def _save_json_gz(path: Path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with gzip.open(tmp, "wt", encoding="utf-8") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(tmp, path)


def _load_json_gz(path: Path):
    with gzip.open(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def bundle_key(lat, lon, radius, cell, roads):
    return _key(f"{lat:.4f}", f"{lon:.4f}", f"r{radius:g}", f"c{int(cell)}", roads)


# ------------------------------------------------------------------ bundle build

def build_bundle(job: dict, p: dict):
    def progress(msg):
        job["progress"] = msg
        job["log"].append(f"{time.strftime('%H:%M:%S')} {msg}")

    lat, lon = float(p["lat"]), float(p["lon"])
    radius, cell = float(p["radius"]), float(p["cell"])
    roads = p.get("roads", "major")
    country = (p.get("country") or "").lower()
    ext = Extent(lat, lon, radius)
    ext_key = _key(f"{lat:.4f}", f"{lon:.4f}", f"r{radius:g}")

    # ---- population (raw source data cached independent of cell size)
    if country == "us":
        src_path = CACHE / "population" / f"census_{ext_key}.npz"
        if src_path.exists():
            progress("Population: loading cached Census blocks")
            raw = dict(np.load(src_path))
        else:
            with FETCH_LOCK:
                raw = sources.fetch_census_blocks(ext, progress)
            np.savez_compressed(src_path, **raw)
        pop, land = sources.grid_census(raw, ext, cell)
        pop_src = f"US Census 2020 P.L. 94-171, block level ({len(raw['pop']):,} blocks via TIGERweb)"
        pop_res = "census block (typ. 0.01-0.1 km² urban)"
    else:
        pop = None
        vrt_path = CACHE / "population" / "hrsl_general-latest.vrt"
        if not vrt_path.exists():
            progress("Fetching HRSL mosaic index")
            import urllib.request
            req = urllib.request.Request(sources.HRSL_BASE + "hrsl_general-latest.vrt", headers={"User-Agent": sources.UA})
            vrt_path.write_bytes(urllib.request.urlopen(req, timeout=120).read())
        vrt = vrt_path.read_text()
        n = int(math.ceil(2 * ext.R / cell))
        S = water_mod.SUB
        hrsl_path = CACHE / "population" / f"hrsl_{ext_key}.npz"
        kontur_path = CACHE / "population" / f"kontur_{ext_key}.npz"
        raw = None
        if hrsl_path.exists():
            progress("Population: loading cached HRSL window")
            raw = {k: (v.item() if v.ndim == 0 else v) for k, v in dict(np.load(hrsl_path)).items()}
        elif not kontur_path.exists():
            with FETCH_LOCK:
                raw = sources.fetch_hrsl(ext, vrt, progress)
            if raw is not None:
                np.savez_compressed(hrsl_path, **raw)
        if raw is not None:
            pop_sub, _ = sources.grid_raster(raw, ext, cell / S, n * S)
            pop = pop_sub.reshape(n, S, n, S).sum(axis=(1, 3))
            pop_src = f"Meta/CIESIN High Resolution Settlement Layer, 1 arc-second (~30 m) ({raw['url']})"
            pop_res = "1 arc-second (~30 m)"
        else:
            if kontur_path.exists():
                progress("Population: loading cached Kontur hexagons")
                pts = {k: (v.item() if v.ndim == 0 else v) for k, v in dict(np.load(kontur_path)).items()}
            else:
                progress("No HRSL coverage here; using Kontur Population")
                with FETCH_LOCK:
                    gpkg = sources.kontur_gpkg(country, CACHE / "population", progress)
                    pts = sources.fetch_kontur(ext, gpkg, progress)
                if pts is None:
                    raise RuntimeError("no population data found for this location")
                np.savez_compressed(kontur_path, **pts)
            pop = sources.grid_points(pts, ext, cell, n)
            # hexagon samples are too sparse for a sub-cell emptiness test, so
            # the sea flood uses the cell-level density replicated to sub-cells
            pop_sub = np.repeat(np.repeat(pop / (S * S), S, 0), S, 1)
            pop_src = f"Kontur Population 2023 (H3 resolution-8 hexagons, ~400 m; {pts['url']})"
            pop_res = "H3 hexagon, ~0.74 km²"
        water_path = CACHE / "osm" / f"water_{ext_key}.json.gz"
        if water_path.exists():
            water_osm = _load_json_gz(water_path)
        else:
            with FETCH_LOCK:
                water_osm = sources.fetch_water(ext, progress)
            _save_json_gz(water_path, water_osm)
        progress("Rasterising land/water mask")
        land = water_mod.land_fraction(ext, cell, water_osm, pop_sub)

    # ---- roads
    osm_path = CACHE / "osm" / f"osm_{roads}_{ext_key}.json.gz"
    if osm_path.exists():
        progress("Roads: loading cached OpenStreetMap extract")
        osm = _load_json_gz(osm_path)
    else:
        with FETCH_LOCK:
            osm = sources.fetch_osm(ext, roads, progress)
        _save_json_gz(osm_path, osm)

    progress("Building simulation grid")
    road_out = []
    for w in osm["ways"]:
        pts = w["p"]
        la = np.array(pts[0::2])
        lo = np.array(pts[1::2])
        x, y = ext.xy(la, lo)
        x = np.round(x).astype(int)
        y = np.round(y).astype(int)
        # drop near-duplicate vertices (< 8 m) to shrink payload
        keep = [0]
        for i in range(1, len(x)):
            if abs(x[i] - x[keep[-1]]) + abs(y[i] - y[keep[-1]]) >= 8 or i == len(x) - 1:
                keep.append(i)
        flat = np.empty(2 * len(keep), dtype=int)
        flat[0::2] = x[keep]
        flat[1::2] = y[keep]
        road_out.append([w["c"], w.get("b", 0)] + flat.tolist())
    places = []
    for pl in osm["places"]:
        x, y = ext.xy(pl["lat"], pl["lon"])
        if abs(x) <= ext.R and abs(y) <= ext.R and pl.get("name"):
            places.append({"name": pl["name"], "kind": pl["kind"], "x": round(float(x)), "y": round(float(y))})

    n = pop.shape[0]
    bundle = {
        "name": p.get("name") or f"{lat:.3f},{lon:.3f}",
        "country": country, "lat0": lat, "lon0": lon, "radiusKm": radius, "cellM": cell, "n": n,
        "kx": ext.kx, "ky": ext.ky,
        "pop": [round(float(v), 1) for v in pop.ravel()],
        "land": [round(float(v), 3) for v in land.ravel()],
        "roads": road_out, "roadDetail": roads, "places": places,
        "sources": {
            "population": pop_src, "populationResolution": pop_res,
            "roads": f"OpenStreetMap contributors (ODbL), {len(road_out):,} ways, detail={roads}",
            "places": f"OpenStreetMap place nodes ({len(places)})",
        },
        "totalPop": float(pop.sum()), "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    key = bundle_key(lat, lon, radius, cell, roads)
    bundle["key"] = key
    _save_json_gz(CACHE / "bundles" / f"{key}.json.gz", bundle)
    meta_path = CACHE / "bundles" / "index.json"
    idx = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    idx[key] = {"name": bundle["name"], "lat": lat, "lon": lon, "radius": radius, "cell": cell,
                "roads": roads, "country": country, "totalPop": bundle["totalPop"], "builtAt": bundle["builtAt"]}
    meta_path.write_text(json.dumps(idx, indent=1))
    progress("Done")
    return key


def run_job(job_id: str, params: dict):
    job = JOBS[job_id]
    try:
        job["key"] = build_bundle(job, params)
        job["status"] = "done"
    except Exception as e:
        traceback.print_exc()
        job["status"] = "error"
        job["error"] = f"{type(e).__name__}: {e}"


# ------------------------------------------------------------------ HTTP

class Handler(BaseHTTPRequestHandler):
    server_version = "ZombieSim/1.0"

    def log_message(self, fmt, *args):
        if "/api/job/" not in (args[0] if args else ""):
            super().log_message(fmt, *args)

    def _send(self, code, body: bytes, ctype="application/json", gz=False, cache=False):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "max-age=3600" if cache else "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        raw = json.dumps(obj).encode()
        if len(raw) > 2048 and "gzip" in self.headers.get("Accept-Encoding", ""):
            self._send(code, gzip.compress(raw, 5), gz=True)
        else:
            self._send(code, raw)

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/presets":
                idx_path = CACHE / "bundles" / "index.json"
                idx = json.loads(idx_path.read_text()) if idx_path.exists() else {}
                return self._json({
                    "presets": [{"name": n, "country": c, "lat": la, "lon": lo, "radius": r} for n, c, la, lo, r in PRESETS],
                    "cached": idx,
                })
            if u.path == "/api/geocode":
                h = hashlib.sha1(q.get("q", "").strip().lower().encode()).hexdigest()[:16]
                path = CACHE / "geocode" / f"{h}.json"
                if path.exists():
                    return self._json(json.loads(path.read_text()))
                res = sources.geocode(q.get("q", ""))
                path.write_text(json.dumps(res))
                return self._json(res)
            if u.path == "/api/city":
                lat, lon = float(q["lat"]), float(q["lon"])
                radius = max(2.0, min(40.0, float(q.get("radius", 15))))
                cell = max(100.0, min(2000.0, float(q.get("cell", 400))))
                roads = q.get("roads", "major") if q.get("roads") in ("major", "all") else "major"
                key = bundle_key(lat, lon, radius, cell, roads)
                if (CACHE / "bundles" / f"{key}.json.gz").exists() and q.get("refresh") != "1":
                    return self._json({"status": "done", "key": key, "cached": True})
                params = {**q, "radius": radius, "cell": cell, "roads": roads}
                with JOBS_LOCK:
                    for jid, j in JOBS.items():  # de-duplicate concurrent requests
                        if j["key_expected"] == key and j["status"] == "running":
                            return self._json({"status": "running", "job": jid})
                    jid = uuid.uuid4().hex[:10]
                    JOBS[jid] = {"status": "running", "progress": "Queued", "log": [], "key_expected": key}
                threading.Thread(target=run_job, args=(jid, params), daemon=True).start()
                return self._json({"status": "running", "job": jid})
            if u.path.startswith("/api/job/"):
                j = JOBS.get(u.path.rsplit("/", 1)[-1])
                if not j:
                    return self._json({"status": "error", "error": "unknown job"}, 404)
                return self._json({k: v for k, v in j.items() if k != "key_expected"})
            if u.path.startswith("/api/bundle/"):
                key = u.path.rsplit("/", 1)[-1]
                path = CACHE / "bundles" / f"{os.path.basename(key)}.json.gz"
                if not path.exists():
                    return self._json({"error": "not cached"}, 404)
                body = path.read_bytes()
                if "gzip" in self.headers.get("Accept-Encoding", ""):
                    return self._send(200, body, gz=True, cache=True)
                return self._send(200, gzip.decompress(body), cache=True)
            # static files
            rel = u.path.lstrip("/") or "index.html"
            fp = (WEB / rel).resolve()
            if not str(fp).startswith(str(WEB)) or not fp.is_file():
                return self._send(404, b"not found", "text/plain")
            ctype = mimetypes.guess_type(str(fp))[0] or "application/octet-stream"
            if fp.suffix == ".js":
                ctype = "text/javascript"
            return self._send(200, fp.read_bytes(), ctype)
        except Exception as e:
            traceback.print_exc()
            return self._json({"status": "error", "error": f"{type(e).__name__}: {e}"}, 500)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true")
    a = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    url = f"http://localhost:{a.port}/"
    print(f"ZombieSim serving {WEB} at {url}  (cache: {CACHE})")
    if not a.no_browser:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
