// Headless render test for the packaged visual.
//
//   npx pbiviz package && npm run test:render
//
// Loads .tmp/drop/visual.js into an <iframe sandbox="allow-scripts"> (the same opaque-origin sandbox
// Power BI uses), drives it with a mock host + categorical DataViews, checks behaviour and writes
// screenshots to test/output/. Needs Chromium: set CHROMIUM_PATH or PLAYWRIGHT_BROWSERS_PATH.
import { readFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { STATIONS } from "./fixtures.mjs";

const pbiviz = JSON.parse(readFileSync("pbiviz.json", "utf8"));
const guid = pbiviz.visual.guid;
const js = readFileSync(".tmp/drop/visual.js", "utf8");
const css = readFileSync(".tmp/drop/visual.css", "utf8");
mkdirSync("test/output", { recursive: true });

function chromiumPath() {
    if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
    const dir = readdirSync(root).find(d => /^chromium-\d+$/.test(d));
    const candidates = [join(root, dir ?? "", "chrome-linux", "chrome"), join(root, "chromium")];
    return candidates.find(existsSync);
}

// Mock Power BI host, evaluated inside the sandboxed frame before visual.js.
const hostScript = `
window.powerbi = {};
window.__log = { select: [], tooltip: [], filters: [], rendering: [], contextMenu: 0 };
function makeId(key) {
  return { key, equals(o) { return !!o && o.key === key; }, includes(o) { return !!o && o.key === key; },
           getKey() { return key; }, getSelector() { return { data: [] }; }, getSelectorsByColumn() { return {}; }, hasIdentity() { return true; } };
}
let selected = [];
let onSelect = () => {};
const palette = ["#118DFF", "#12239E", "#E66C37", "#6B007B", "#E044A7", "#744EC2", "#D9B300", "#D64550"];
const paletteMap = new Map();
window.__host = {
  eventService: {
    renderingStarted() { __log.rendering.push("started"); },
    renderingFinished() { __log.rendering.push("finished"); },
    renderingFailed(_o, reason) { __log.rendering.push("failed:" + reason); }
  },
  hostCapabilities: { allowInteractions: true },
  colorPalette: { getColor(k) { if (!paletteMap.has(k)) paletteMap.set(k, palette[paletteMap.size % palette.length]); return { value: paletteMap.get(k) }; }, reset() { return this; } },
  tooltipService: {
    enabled: () => true,
    show(o) { __log.tooltip.push({ type: "show", items: o.dataItems }); },
    move() {},
    hide() { __log.tooltip.push({ type: "hide" }); }
  },
  createSelectionIdBuilder() {
    let key = "";
    return { withCategory(cat, i) { key += cat.source.queryName + "=" + cat.values[i] + ";"; return this; },
             withMeasure(m) { key += m; return this; }, withSeries() { return this; }, createSelectionId() { return makeId(key); } };
  },
  createSelectionManager() {
    return {
      select(id, multi) { const ids = Array.isArray(id) ? id : [id]; __log.select.push({ keys: ids.map(i => i.key), multi });
        selected = multi ? selected.concat(ids) : ids; return Promise.resolve(selected); },
      clear() { selected = []; return Promise.resolve({}); },
      hasSelection() { return selected.length > 0; },
      getSelectionIds() { return selected; },
      registerOnSelectCallback(cb) { onSelect = cb; },
      showContextMenu() { __log.contextMenu++; return Promise.resolve({}); },
      toggleExpandCollapse() { return Promise.resolve({}); }
    };
  },
  applyJsonFilter(filter, obj, prop, action) { __log.filters.push({ filter, action }); },
  persistProperties(changes) { (__log.persisted ||= []).push(changes); },
  locale: "en-GB"
};
`;

const html = `<!doctype html><html><head><style>html,body{margin:0;height:100%}#root{width:900px;height:620px}</style>
<style>${css}</style></head><body><div id="root"></div>
<script>${hostScript}</script>
<script>${js.replace(/<\/script/g, "<\\/script")}</script>
<script>
  window.__visual = powerbi.visuals.plugins["${guid}"].create({ element: document.getElementById("root"), host: __host });
  window.__ready = true;
</script></body></html>`;

const outer = `<!doctype html><html><body style="margin:0">
<iframe id="sandbox" sandbox="allow-scripts" style="border:0;width:900px;height:620px"></iframe>
</body></html>`;

// ---- DataView builders ---------------------------------------------------------------

const col = (displayName, role, queryName, type = { text: true }) =>
    ({ displayName, queryName, roles: { [role]: true }, type, expr: { source: { entity: queryName.split(".")[0] }, ref: queryName.split(".")[1] } });

function haversineMiles(lat1, lon1, lat2, lon2) {
    const r = d => d * Math.PI / 180;
    const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
    return 3958.8 * 2 * Math.asin(Math.sqrt(a));
}

// Which sample rectangle (sample/combined_layers.sample.geojson) a station falls in.
const sample = JSON.parse(readFileSync("sample/combined_layers.sample.geojson", "utf8"));
function constituencyOf(lat, lon) {
    for (const f of sample.features) {
        if (f.geometry.type !== "Polygon") continue;
        const [[x0, y0], [x1], [, y2]] = [f.geometry.coordinates[0][0], f.geometry.coordinates[0][1], f.geometry.coordinates[0][2]];
        if (lon >= x0 && lon <= x1 && lat >= y0 && lat <= y2) return f.properties.PCON24NM;
    }
    return "Outside sample";
}

function dataView({ radius = null, objects = {} } = {}) {
    const rows = STATIONS;
    const station = { source: col("Station", "station", "Parliament_MPs.Station_Name"), values: rows.map(r => r[0]) };
    const lat = { source: col("Latitude", "latitude", "Parliament_MPs.Latitude", { numeric: true }), values: rows.map(r => r[2]) };
    const lon = { source: col("Longitude", "longitude", "Parliament_MPs.Longitude", { numeric: true }), values: rows.map(r => r[3]) };
    const sfo = { source: col("Station Facility Owner", "facilityOwner", "Parliament_MPs.Station_Facility_Owner"), values: rows.map(r => r[4]) };
    const pcon = { source: col("Constituency", "constituency", "Parliament_MPs.Constituency"), values: rows.map(r => constituencyOf(r[2], r[3])) };
    const crs = { source: col("CRS", "details", "Parliament_MPs.CRS"), values: rows.map(r => r[1]) };
    const mp = { source: col("MP_Name", "details", "Parliament_MPs.MP_Name"), values: rows.map(r => "MP for " + constituencyOf(r[2], r[3])) };
    const mainline = { source: col("Mainline", "mainline", "Parliament_MPs.Mainline"), values: rows.map(r => r[5]) };
    const categories = [station, lat, lon, sfo, pcon, mainline, crs, mp];
    const values = [];
    if (radius) {
        const flag = rows.map(r => haversineMiles(radius.lat, radius.lon, r[2], r[3]) <= radius.miles ? 1 : 0);
        values.push({ source: { displayName: "In_Radius", queryName: "m.In_Radius", roles: { inRadius: true }, type: { numeric: true } }, values: flag });
        values.push({ source: { displayName: "Sel_Lat", queryName: "m.Sel_Lat", roles: { radiusLat: true }, type: { numeric: true } }, values: rows.map(() => radius.lat) });
        values.push({ source: { displayName: "Sel_Lon", queryName: "m.Sel_Lon", roles: { radiusLon: true }, type: { numeric: true } }, values: rows.map(() => radius.lon) });
        values.push({ source: { displayName: "Radius_mi", queryName: "m.Radius_mi", roles: { radiusMiles: true }, type: { numeric: true } }, values: rows.map(() => radius.miles) });
    }
    values.push({ source: { displayName: "Serving operators", queryName: "m.Operators", roles: { tooltips: true }, type: { text: true } }, values: rows.map(r => r[4] + ", CrossCountry") });
    return {
        metadata: { columns: [...categories.map(c => c.source), ...values.map(v => v.source)], objects },
        categorical: { categories, values }
    };
}

// ---- Test run ------------------------------------------------------------------------

const failures = [];
const check = (condition, message) => { console.log(`${condition ? "PASS" : "FAIL"}  ${message}`); if (!condition) failures.push(message); };

const browser = await chromium.launch({
    executablePath: chromiumPath(),
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
});
const page = await browser.newPage({ viewport: { width: 900, height: 620 } });
const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("console", m => { if (m.type() === "error" || m.type() === "warning") console.log(`  [console.${m.type()}] ${m.text()}`); });
await page.setContent(outer);
await page.$eval("#sandbox", (el, doc) => { el.srcdoc = doc; }, html);
let frame;
for (let i = 0; i < 100 && !frame; i++) {
    frame = page.frames().find(f => f !== page.mainFrame());
    if (!frame) await page.waitForTimeout(50);
}
await frame.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

check(await frame.evaluate(() => window.origin === "null"), "visual runs in an opaque-origin sandbox (like Power BI)");

const update = async (dv, extra = {}) => {
    await frame.evaluate(([dv, extra]) => {
        window.__visual.update({ dataViews: dv ? [dv] : [], viewport: { width: 900, height: 620 }, type: 2, jsonFilters: extra.jsonFilters ?? [] });
    }, [dv, extra]);
    await frame.waitForFunction(() => window.__visual.map.loaded() && window.__visual.map.isStyleLoaded() && !window.__visual.map.isMoving(), null, { timeout: 30000 });
    await frame.evaluate(() => new Promise(r => window.__visual.map.once("idle", r) && window.__visual.map.triggerRepaint()));
};
const sourceData = id => frame.evaluate(id => window.__visual.map.getSource(id).serialize().data, id);
const sourceCount = async id => (await sourceData(id)).features.length;
const project = (lon, lat) => frame.evaluate(([lon, lat]) => { const p = window.__visual.map.project([lon, lat]); return { x: p.x, y: p.y }; }, [lon, lat]);
const shot = name => page.screenshot({ path: `test/output/${name}.png` });

// 1. No data bound: reference layers only.
await update(null);
check(await sourceCount("dfto-constituencies") === 6, "constituency polygons loaded from bundled GeoJSON");
check(await sourceCount("dfto-rail") === 2, "rail lines loaded from bundled GeoJSON");
check(await frame.evaluate(() => window.__visual.map.queryRenderedFeatures({ layers: ["dfto-constituency-label"] }).length) > 0,
    "constituency labels rendered with bundled glyphs (no network)");
const lineClasses = await frame.evaluate(() => window.__visual.map.querySourceFeatures("dfto-rail").map(f => f.properties.__class).sort());
check(lineClasses.includes("mainline") && lineClasses.includes("branch"), "mainline and branch lines classified");
await shot("1-reference-layers");

// 2. Stations bound, no radius search.
await update(dataView());
check(await sourceCount("dfto-stations") === STATIONS.length - 1, "all valid stations drawn; projected (BNG) row skipped");
check((await frame.evaluate(() => document.querySelector(".dfto-notice").textContent)).includes("1 station(s) skipped"), "invalid-coordinate notice shown");
check(await frame.evaluate(() => document.querySelector(".dfto-legend-section").querySelectorAll(".dfto-legend-row").length) === 4, "SFO legend lists 4 owners");
await shot("2-stations");

// 3. Radial search: 6 miles around Birmingham New Street.
const radius = { lat: 52.4778, lon: -1.8989, miles: 6 };
const expected = STATIONS.filter(r => Math.abs(r[2]) <= 90 && haversineMiles(radius.lat, radius.lon, r[2], r[3]) <= radius.miles).length;
const zoomBefore = await frame.evaluate(() => window.__visual.map.getZoom());
await update(dataView({ radius }));
check(await sourceCount("dfto-stations") === expected, `In_Radius hides out-of-radius stations (${expected} shown)`);
check(await sourceCount("dfto-radius") === 1, "search radius circle drawn");
const zoomAfter = await frame.evaluate(() => window.__visual.map.getZoom());
check(zoomAfter > zoomBefore, `auto-zoom tightened to the radius (zoom ${zoomBefore.toFixed(2)} → ${zoomAfter.toFixed(2)})`);
await shot("3-radius-search");

// 4. Tooltip on hover — no coordinates in it.
const newStreet = await project(-1.8989, 52.4778);
await page.mouse.move(newStreet.x, newStreet.y);
await page.waitForTimeout(200);
const tip = await frame.evaluate(() => window.__log.tooltip.filter(t => t.type === "show").pop());
check(!!tip && tip.items[0].value === "Birmingham New Street", "station tooltip shown on hover");
check(!!tip && !tip.items.some(i => /lat|long/i.test(i.displayName)), "tooltip has no latitude/longitude");
check(!!tip && tip.items.some(i => i.displayName === "Serving operators") && tip.items.some(i => i.displayName === "Constituency"), "tooltip includes operators and constituency");

// 5. Click a station → cross-filter selection, others dimmed.
await page.mouse.click(newStreet.x, newStreet.y);
await page.waitForTimeout(300);
const sel = await frame.evaluate(() => window.__log.select.pop());
check(!!sel && sel.keys[0].includes("Birmingham New Street"), "clicking a station selects it (cross-filter)");
const dimmed = (await sourceData("dfto-stations")).features.filter(f => f.properties.dim === 1).length;
check(dimmed === expected - 1, "unselected stations dimmed");
await shot("4-station-selected");

// 6. Click inside a constituency away from stations → BasicFilter on the Constituency column.
await update(dataView());
const empty = await project(-1.35, 52.44);
await page.mouse.click(empty.x, empty.y);
await page.waitForTimeout(300);
const filter = await frame.evaluate(() => window.__log.filters.pop());
const pconFilter = [].concat(filter?.filter ?? [])[0];
check(!!pconFilter && pconFilter.values?.[0] === "Sample South East" && pconFilter.target.column === "Constituency", "clicking a polygon applies a constituency filter");
await update(dataView(), { jsonFilters: [pconFilter] });
const selectedOutline = await frame.evaluate(() => JSON.stringify(window.__visual.map.getFilter("dfto-constituency-selected")));
check(selectedOutline.includes("Sample South East"), "filtered constituency outlined");
await shot("5-constituency-filter");

// 6b. Constituency hover: tooltip with name + MP from the report data, and a hover highlight.
await update(dataView());
await page.mouse.move(0, 0);
const pconPoint = await project(-1.95, 52.68);
await page.mouse.move(pconPoint.x, pconPoint.y);
await page.waitForTimeout(250);
const pconTip = await frame.evaluate(() => window.__log.tooltip.filter(t => t.type === "show").pop());
check(!!pconTip && pconTip.items[0].displayName === "Constituency" && pconTip.items[0].value === "Sample North West", "hovering a constituency shows its name");
check(!!pconTip && pconTip.items.some(i => i.displayName === "MP_Name" && i.value === "MP for Sample North West"), "constituency tooltip includes the MP from report data");
check(!!pconTip && pconTip.items.some(i => i.displayName === "Stations shown") && pconTip.items.some(i => i.displayName === "Mainline stations"), "constituency tooltip counts stations and mainline stations");
check(JSON.stringify(await frame.evaluate(() => window.__visual.map.getFilter("dfto-constituency-hover"))).includes("Sample North West"), "hovered constituency highlighted");
await shot("5b-constituency-hover");

// 6c. Rail lines: hover tooltip + highlight, click filters the report on the Mainline column.
const onMain = await project(-1.775, 52.475);
await page.mouse.move(onMain.x, onMain.y + 2);
await page.waitForTimeout(250);
const lineTip = await frame.evaluate(() => window.__log.tooltip.filter(t => t.type === "show").pop());
check(!!lineTip && lineTip.items.some(i => i.displayName === "Line" && i.value === "Sample Main Line") && lineTip.items.some(i => i.value === "Mainline"), "hovering a mainline shows its name and type");
check(!!lineTip && lineTip.items.some(i => i.displayName === "Stations shown on this line"), "line tooltip counts the line's stations");
check(JSON.stringify(await frame.evaluate(() => window.__visual.map.getFilter("dfto-rail-hover"))).includes("Sample Main Line"), "hovered line highlighted");
await shot("5c-line-hover");
await page.mouse.click(onMain.x, onMain.y + 2);
await page.waitForTimeout(300);
const lineFilter = [].concat((await frame.evaluate(() => window.__log.filters.pop()))?.filter ?? [])[0];
check(!!lineFilter && lineFilter.target.column === "Mainline" && lineFilter.values[0] === "Sample Main Line", "clicking a line filters the report to that line");
await update(dataView(), { jsonFilters: [lineFilter] });
check(JSON.stringify(await frame.evaluate(() => window.__visual.map.getFilter("dfto-rail-selected"))).includes("Sample Main Line"), "filtered line highlighted");
await shot("5d-line-filter");
const branchPoint = await project(-1.8, 52.66);
await page.mouse.move(branchPoint.x + 1, branchPoint.y);
await page.waitForTimeout(250);
const branchTip = await frame.evaluate(() => window.__log.tooltip.filter(t => t.type === "show").pop());
check(!!branchTip && branchTip.items.some(i => i.value === "Non-mainline (branch)"), "hovering a branch line shows it is non-mainline");

// 6d. Mainline / non-mainline station styling and filtering.
await update(dataView({ objects: { stations: { colourBy: "mainline", stationFilter: "mainline" } } }));
const mainStations = (await sourceData("dfto-stations")).features;
const expectedMain = STATIONS.filter(r => Math.abs(r[2]) <= 90 && r[5] !== "No").length;
check(mainStations.length === expectedMain, `"Mainline stations only" shows ${expectedMain} stations`);
check(mainStations.every(f => f.properties.colour === "#1F3A5F"), "stations coloured as mainline");
const legendText = await frame.evaluate(() => document.querySelector(".dfto-legend").textContent);
check(legendText.includes("Mainline station") && legendText.includes("Non-mainline (branch)"), "legend explains station colours and line types");
await shot("5e-mainline-stations");

// 6e. On-map layer switcher toggles layers and persists the choice.
await update(dataView());
const toggled = await frame.evaluate(() => {
    const box = [...document.querySelectorAll(".dfto-layer-item")].find(l => l.textContent === "Non-mainline lines").querySelector("input");
    box.click();
    return window.__visual.map.getLayoutProperty("dfto-rail-branch", "visibility");
});
check(toggled === "none", "layer switcher hides non-mainline lines");

// 7. Formatting: remote base map unreachable here → falls back to offline style, overlay intact.
await update(dataView({ objects: { baseMap: { style: "positron" }, railLines: { dashBranches: true }, constituencyLabels: { fontSize: 14 } } }));
await frame.waitForFunction(() => document.querySelector(".dfto-notice").textContent.includes("Base map unavailable"), null, { timeout: 15000 }).catch(() => {});
await update(dataView({ objects: { baseMap: { style: "positron" }, railLines: { dashBranches: true }, constituencyLabels: { fontSize: 14 } } }));
const notice = await frame.evaluate(() => document.querySelector(".dfto-notice").textContent);
const online = await frame.evaluate(() => window.__visual.map.getStyle().sources.openmaptiles !== undefined);
check(online || notice.includes("Base map unavailable"), online ? "remote base map loaded" : "blocked base map falls back to offline map with notice");
check(await sourceCount("dfto-stations") === STATIONS.length - 1, "overlay intact after base-map switch");
check(JSON.stringify(await frame.evaluate(() => window.__visual.map.getPaintProperty("dfto-rail-branch", "line-dasharray"))) === "[3,2]", "format pane: dashed branch lines applied");
check(JSON.stringify(await frame.evaluate(() => window.__visual.map.getLayoutProperty("dfto-constituency-label", "text-size"))).includes(",8,14,"), "format pane: label size applied");
await shot("6-formatting");

check(pageErrors.length === 0, `no uncaught errors${pageErrors.length ? ": " + pageErrors.join(" | ") : ""}`);
const rendering = await frame.evaluate(() => window.__log.rendering);
check(!rendering.some(r => r.startsWith("failed")), "renderingFinished/renderingFailed events: no failures");

await browser.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed; screenshots in test/output/");
process.exit(failures.length ? 1 : 0);
