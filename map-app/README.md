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

1. ✅ Clean grayscale base map from OpenFreeMap **Positron** (`https://tiles.openfreemap.org/styles/positron`). It is free and needs no API key or token. MapLibre loads the style directly, then the page hides roads, rail, buildings, parks, land use, POIs and village/suburb names, and keeps Positron's own pale colours. A *Place names* checkbox hides the remaining city/town names. If OpenFreeMap can't be reached, the page switches to desaturated, lightened OpenStreetMap raster tiles (no key) and says why in the status bar. Centred on the Midlands (52.5, −1.5, zoom 8).
2. ⏳ Waiting for `combined_layers.geojson` (constituency polygons + rail lines), to be placed in this folder.
3.–8. Labels, rail layers, stations, toggles, radial search and tooltips come after the data files arrive.
