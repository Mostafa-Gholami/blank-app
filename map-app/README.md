# DFTO Rail Map – standalone MapLibre app

Single-page MapLibre GL map, built step by step before it is wrapped as a Power BI visual.

## Run it

Serve the folder over HTTP. Browsers block `fetch()` of local files from `file://`, and later steps load your GeoJSON that way.

```bash
cd map-app
python -m http.server 8000
# open http://localhost:8000
```

## Status

1. ✅ Clean grayscale base map, like Azure Maps' *Grayscale Light*. OpenFreeMap's Positron vector style is restyled in the page: near-white land, soft blue-grey water, faint dashed boundaries and small grey city/town names, with no roads, rail, buildings, parks or POIs. A *Place names* checkbox hides the names. If the vector style can't be fetched, it uses CARTO `light_nolabels` raster tiles, which have the same pale look and no labels. Both are free and need no key. Centred on the Midlands (52.5, −1.5, zoom 8).
2. ⏳ Waiting for `combined_layers.geojson` (constituency polygons + rail lines), to be placed in this folder.
3.–8. Labels, rail layers, stations, toggles, radial search and tooltips come after the data files arrive.
