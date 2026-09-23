# DFTO Rail Map — MapLibre custom visual for Power BI

A Power BI custom visual (`.pbiviz`) built on [MapLibre GL JS](https://maplibre.org), to replace the Azure Maps visual in the
DFTO TOC Mapping dashboard (P2026-8xx, GB rollout of the P2025-770 Midlands PoC). It needs no access token and has no per-load cost.
By default it runs **fully offline**: the constituency/rail GeoJSON and the label fonts are bundled into the visual.
The same `.pbiviz` works in Power BI Desktop, the Power BI Service and Fabric.

| Azure Maps limitation | This visual |
|---|---|
| Forced lat/long tooltip | Tooltip is built only from the fields you bind. It never shows coordinates. |
| No constituency labels | On-map labels from `PCON24NM`, placed inside each polygon. Fonts are bundled. |
| No zoom-to-selection | Reframes to the filtered stations, the search circle and the clicked constituency. |
| No roadless base map | Default base map is blank (no roads). Online styles strip road layers when **Hide roads** is on. |
| Reference layer not interactive | Clicking a polygon filters the report to that constituency. |

## Quick start

```bash
cd dftoMapLibreMap
npm ci
npm run package        # → dist/*.pbiviz  (import via Visualizations pane → … → Import a visual from a file)
npm start              # dev server for Power BI Service "Developer visual" (needs developer mode + trusted cert: npx pbiviz install-cert)
```

Checks you can run locally:

```bash
npm run typecheck && npm run lint
npm run package && npm run test:render   # headless Chromium render test in a Power-BI-like sandboxed iframe → test/output/*.png
```

## Field wells (data roles)

| Well | Bind (existing model) | Notes |
|---|---|---|
| **Station** | `Station_Name` (or `CRS`) | Required. One row per station. Also the cross-filter key when you click a station. |
| **Latitude / Longitude** | `Parliament_MPs[Latitude]` / `[Longitude]` | WGS84 decimal degrees. Set to *Don't summarize* where possible. Rows with projected coordinates (BNG) are skipped and counted in a notice. |
| **Station Facility Owner (colour)** | `Station_Facility_Owner` | Sets the bubble colour and the legend. |
| **Constituency** | `Constituency` | Values must match `PCON24NM` in the GeoJSON. This field is what makes polygon clicks filter the report. |
| **Tooltip details** | `CRS`, `MP_Name`, `Mainline`, `District`, `County` | Grouping columns, shown in the station tooltip in the order you add them. |
| **In radius flag** | `[In_Radius]` | Stations where it is 0, blank or false are hidden (*Stations → Hide stations outside radius*). |
| **Radius centre lat / lon, Radius (miles)** | `[Sel_Lat]`, `[Sel_Lon]`, `[Radius_mi Value]` | Optional. Draws the search circle and includes it in the zoom. |
| **Tooltip measures** | e.g. serving operators | Any measures. If a station has several operators, concatenate them so the station stays on one row: |

```DAX
Serving Operators =
CONCATENATEX ( VALUES ( Station_Operators[Operator_Name] ), Station_Operators[Operator_Name], ", " )
```

(Change the table and column names to match the model.) The radial-search station picker has to stay on the **disconnected**
selection table the current DAX uses. If it filtered the same Station column this visual is bound to, the visual would only ever show one station.

## Interactions

- **Hover a station**: Power BI tooltip with the bound fields and no coordinates. Report-page (canvas) tooltips are declared in capabilities but not yet tested.
- **Click a station**: cross-filters or cross-highlights other visuals. Ctrl/Shift+click adds stations to the selection. Unselected stations are dimmed.
- **Click a constituency**: applies a basic filter on the bound Constituency column (`In [name]`) and outlines the polygon.
  Click it again, or click outside all polygons, to clear the filter. If no Constituency field is bound, the click only zooms to the polygon.
- **Right-click**: Power BI context menu (drill through, etc.).
- **Other visuals highlighting this one**: stations that aren't highlighted are dimmed.
- **Zoom**: when the set of visible stations, the search radius or the constituency filter changes, the map reframes to it (*Zoom → Zoom to filtered data*).

## Constituency / rail GeoJSON (bundled)

The visual imports `src/data/combined_layers.json`. **The repo ships a synthetic placeholder**
(`sample/combined_layers.sample.geojson`: six rectangles named "Sample …" and two lines). Swap in the real layer before use:

```bash
npm run prepare-geojson -- /path/to/combined_layers.geojson           # rounds to 5 dp (~1 m), reports size
npm run prepare-geojson -- in.geojson --keep PCON24NM,fill,stroke,stroke-width,Party   # also drop unused properties
npm run package
```

- Polygons use the simplestyle `fill` / `stroke` properties already in `combined_layers.geojson`. Fill opacity defaults to 25% and the boundary is drawn at full opacity; both can be changed in the format pane.
  Polygons without colours use *Constituencies → Fallback colour*.
- Lines are split into **mainline** and **branch** by a type-like property (`line_type`, `class`, `type`, `Mainline`, …) when one exists,
  otherwise by `stroke-width` (≥ 2 means mainline). That matches the current file (mainlines 3 px `#333`, branches 1.4 px `#8A8F98`).
- For the full GB set (~650 constituencies), simplify the polygons before bundling to keep the visual quick to load,
  e.g. `npx mapshaper in.geojson -simplify 8% keep-shapes -o out.geojson`. The script warns above 8 MB.
- The script refuses projected (BNG) coordinates. Reproject to EPSG:4326 first.

**Why bundled rather than loading from a SharePoint URL:** a custom visual runs in a sandboxed iframe with an opaque (`null`) origin.
It cannot use the viewer's SharePoint sign-in, so a SharePoint URL would have to be anonymous/public. Every host it fetches from also has
to be declared under `WebAccess` and allowed by the tenant admin. Bundling avoids all of that: no external fetch and nothing to approve.
When the boundaries change, re-run `prepare-geojson`, bump the version in `pbiviz.json`, and re-import the visual.

## Base maps and governance

| Base map (format pane) | Network | Notes |
|---|---|---|
| **Blank (offline, no roads)** — default | none | Background colour plus the overlay. Works with no network access at all. |
| Light / Dark / Detailed (OpenFreeMap) | `https://tiles.openfreemap.org` | Free and needs no key. Roads and base labels are hidden by default (*Hide roads*, *Hide base map labels*). |
| Custom style URL | the style's host | For a self-hosted tile server (full air-gap). Add its origin to `privileges → WebAccess` in `capabilities.json` and rebuild. |

- The only declared privilege is `WebAccess` to `tiles.openfreemap.org`, and it is marked **non-essential**, so the visual works when an admin blocks it.
  If an online style can't load, the visual switches to the offline base map and shows a notice. The overlay is never lost.
- Label fonts (Open Sans Semibold SDF glyphs) are served from the bundle through a custom MapLibre protocol. No font CDN is used. See `scripts/build-glyphs.mjs`.
- No telemetry, no tokens, no cookies, no `localStorage`. Third-party licences are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Format pane

Base map (style, custom URL, hide roads, hide base labels, background) · Constituencies (name property, party colours on/off, fallback colour,
fill opacity, boundary width/opacity, extra tooltip properties) · Constituency labels (size, colour, halo, minimum zoom) ·
Rail lines (mainline/branch colour and width, dashed branches) · Stations (size, opacity, default colour, outline, SFO colour overrides
such as `Northern=#262262; Network Rail=#F15A29`, hide outside radius, station names and their minimum zoom) · Legend (position) ·
Zoom (auto-zoom, padding, max zoom) · Search radius (show, colour, fill opacity).

SFO colours come from the report theme palette unless an override is set.

## Project layout

```
capabilities.json        data roles, format objects, WebAccess privilege
src/visual.ts            map lifecycle, rendering, selection, tooltips, constituency filter, zoom
src/data.ts              DataView → stations (+ radius search, filter target)
src/geo.ts               GeoJSON normalisation, label points, bounds, geodesic circle
src/mapStyle.ts          base styles, road/label stripping, overlay layer specs, bundled glyph protocol
src/settings.ts          format pane model
src/data/combined_layers.json   bundled reference layers (placeholder — replace)
scripts/                 prepare-geojson, build-glyphs
test/render-test.mjs     headless render/interaction test with a mock Power BI host
```

## Status and next steps

Built and verified: `pbiviz package` succeeds, lint and typecheck pass, and the headless render test passes.
The test loads the packaged visual in a sandboxed iframe and covers the reference layers, labels, station bubbles, In_Radius filtering,
the radius circle, auto-zoom, tooltips without coordinates, station selection and dimming, the polygon-click filter, the format pane,
and the fallback when the online base map is blocked. It uses a mock host, so it still has to be checked in real Power BI:

1. Import the `.pbiviz` into Power BI Desktop against the real model. Check the field wells, the `In_Radius` and slicer behaviour, and cross-filtering in both directions.
2. Replace the placeholder GeoJSON with the real `combined_layers.geojson`. Check label placement and the mainline/branch split.
3. Publish to the Service and confirm the tenant allows organisational custom visuals. Confirm OpenFreeMap is allowed, or stay on the offline base map.
4. Possible follow-ups: per-SFO colour pickers in the format pane (instead of the text overrides), keyboard navigation and high-contrast mode,
   a party legend, and clustering if the station count grows well beyond GB (~2,600 stations renders fine without it).
