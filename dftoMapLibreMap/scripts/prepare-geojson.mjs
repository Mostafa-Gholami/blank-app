// Bundles the constituency / rail GeoJSON into the visual.
//
//   npm run prepare-geojson -- path/to/combined_layers.geojson [--precision 5] [--keep PCON24NM,fill,stroke,stroke-width,Party]
//
// Writes src/data/combined_layers.json (the file the visual imports), rounding coordinates
// (5 dp ≈ 1 m) and optionally dropping unused properties to keep the .pbiviz small.
// For GB-wide boundaries, simplify first, e.g.:  npx mapshaper in.geojson -simplify 8% keep-shapes -o out.geojson
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const input = args.find(a => !a.startsWith("--"));
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};
if (!input) {
    console.error("Usage: npm run prepare-geojson -- <combined_layers.geojson> [--precision 5] [--keep prop1,prop2]");
    process.exit(1);
}
const precision = Number(option("precision", "5"));
const keep = option("keep", null)?.split(",").map(s => s.trim()).filter(Boolean);
const factor = 10 ** precision;

const fc = JSON.parse(readFileSync(input, "utf8"));
if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) throw new Error("Input must be a GeoJSON FeatureCollection");

const round = coords => typeof coords[0] === "number"
    ? coords.map(v => Math.round(v * factor) / factor)
    : coords.map(round).filter((c, i, arr) => typeof c[0] !== "number" || i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1]);

let maxAbs = 0;
const visit = c => typeof c[0] === "number" ? (maxAbs = Math.max(maxAbs, Math.abs(c[0]), Math.abs(c[1]))) : c.forEach(visit);
const counts = {};
const features = fc.features.filter(f => f && f.geometry).map(f => {
    counts[f.geometry.type] = (counts[f.geometry.type] ?? 0) + 1;
    visit(f.geometry.coordinates);
    const properties = keep ? Object.fromEntries(Object.entries(f.properties ?? {}).filter(([k]) => keep.includes(k))) : (f.properties ?? {});
    return { type: "Feature", properties, geometry: { type: f.geometry.type, coordinates: round(f.geometry.coordinates) } };
});
if (maxAbs > 180) throw new Error("Coordinates look projected (e.g. British National Grid). Reproject to WGS84 (EPSG:4326) first.");

mkdirSync("src/data", { recursive: true });
const json = JSON.stringify({ type: "FeatureCollection", features });
writeFileSync("src/data/combined_layers.json", json);
const mb = (json.length / 1048576).toFixed(2);
console.log(`Wrote src/data/combined_layers.json: ${features.length} features ${JSON.stringify(counts)}, ${mb} MB`);
if (json.length > 8 * 1048576) console.warn("Warning: over 8 MB. Simplify the polygons (mapshaper) so the visual loads quickly.");
