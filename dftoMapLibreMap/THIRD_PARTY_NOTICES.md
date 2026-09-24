# Third-party components

Bundled into the `.pbiviz`:

| Component | Licence | Notes |
|---|---|---|
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) 5.24.0 | BSD-3-Clause | Map rendering engine. No telemetry, no access token. |
| [polylabel](https://github.com/mapbox/polylabel) 2.1.0 | ISC | Label placement inside constituency polygons. |
| [powerbi-visuals-utils-formattingmodel](https://github.com/microsoft/powerbi-visuals-utils-formattingmodel) | MIT | Format pane model. |
| Open Sans Semibold glyphs (`glyphs/*.pbf`, via [openmaptiles/fonts](https://github.com/openmaptiles/fonts)) | Apache-2.0 | SDF glyph ranges 0–511 and 8192–8447, served from the bundle so labels need no network. |

Only when an online base map is selected (not bundled; loaded at runtime):

| Service | Terms |
|---|---|
| [OpenFreeMap](https://openfreemap.org) styles/tiles | Free, no key. Attribution "© OpenMapTiles © OpenStreetMap contributors" is shown by the map's attribution control. OSM data is ODbL. |
