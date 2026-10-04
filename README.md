# ZombieSim

A spatially explicit, mathematically specified simulation of a zombie epidemic in a real city. Choose a city and the app downloads that city's population distribution, road network, water bodies and neighbourhood names, caches them on disk, and runs a stochastic metapopulation model on them. The model has a live map, time-series charts, closed-form theory and Monte-Carlo ensembles, and it writes a report for every run.

## Running

Requires Python 3.10+ with `numpy`, and a modern browser.

```bash
python3 server/server.py            # opens http://localhost:8765/
python3 server/server.py --no-browser --port 9000
```

1. Pick a preset city, or search for any city worldwide.
2. Adjust the study radius and cell size if needed. The cell size is chosen automatically to keep the grid at about 80 × 80 or smaller.
3. Press **Load city**. The first load downloads data; later loads come from `cache/`.
4. Set parameters in the left panel, or pick a scenario. Click any parameter name for its explanation.
5. Press **Run**. When the run ends, the Report tab fills in automatically.
6. Use the **Ensemble** tab for Monte-Carlo intervals. Runs are spread across all CPU cores.

## Data sources

| What | Where | Resolution |
|---|---|---|
| Population, US | 2020 Census blocks (POP100, AREALAND, AREAWATER) via TIGERweb | census block |
| Population, elsewhere | Meta/CIESIN High Resolution Settlement Layer (COGs on AWS); where HRSL has no coverage, Kontur Population 2023 (one country-wide GeoPackage per country, cached) | 30 m (HRSL) / H3 hexagons ~400 m (Kontur) |
| Land/water, elsewhere | OSM water polygons + coastline flood fill | 1/4 cell |
| Roads, place names | OpenStreetMap via Overpass | vector |
| Geocoding | Nominatim | |

Only the bytes covering the study area are fetched from the large rasters, using HTTP range requests. `server/tiff_window.py` is a small dependency-free GeoTIFF reader with its own LZW decoder.

## Cache layout

```
cache/geocode/      search results
cache/population/   raw Census blocks / HRSL windows / Kontur samples per extent (independent of cell size),
                    plus Kontur country GeoPackages
cache/osm/          roads + places, and water/coastline extracts per extent
cache/bundles/      processed per-(extent, cell size, road detail) bundles + index.json
```

Delete any file to force a re-download.

## Model

See [MODEL.md](MODEL.md), or the **Model** tab in the app, for the full specification and derivations. In brief:

- Compartments S, M (immune), E₁…E_k (Erlang incubation), Z, D (reanimating corpses) in each cell.
- Encounters use a Holling type II rate; outcomes are zombie destroyed, human killed, or human bitten.
- Movement: an 8-neighbour random walk with detailed balance for normal life, panic flight and crowd-seeking zombies. Vehicle trips follow a road-graph kernel. Water can be crossed only on roads (bridges).
- Response: detection threshold, then shelter-in-place, then an armed response that ramps up, military sweeps and an optional cordon.
- Chain-binomial stochastic engine with hybrid partitioning, or a deterministic mean-field engine.
- Analytics: R₀(ρ), critical win probability, critical density, Euler–Lotka growth rate, Fisher–KPP front speed, branching-process extinction probability.

`node tools/headless.mjs cache/bundles/<bundle>.json.gz [stochastic|deterministic] [days]` runs the engine without a browser. It also runs a conservation check.
