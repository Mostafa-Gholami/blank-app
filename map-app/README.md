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

1. ✅ Real base map: OpenFreeMap Light by default, with OpenFreeMap Detailed and OpenStreetMap raster in the drop-down. It falls back to OSM tiles if the vector style can't be fetched. Centred on the Midlands (52.5, −1.5, zoom 8).
2. ⏳ Waiting for `combined_layers.geojson` (constituency polygons + rail lines), to be placed in this folder.
3.–8. Labels, rail layers, stations, toggles, radial search and tooltips come after the data files arrive.
