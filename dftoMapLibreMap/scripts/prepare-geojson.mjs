// Bundles constituency polygons and rail lines into the visual (src/data/combined_layers.json).
//
//   npm run prepare-geojson -- <file.geojson> [more.geojson …] [options]
//
// Inputs are merged, so the constituencies and the rail lines can come from separate files:
//   npm run prepare-geojson -- PCON_JULY_2024_UK_BUC.geojson mainlines.geojson branches.geojson --parties ge2024.csv
//
// Options
//   --parties <csv>        Adds Party / MP_Name / fill / stroke to each constituency. Header row needs a constituency
//                          column (PCON24NM, Constituency or Name) and a Party column; optional MP / MP_Name and Colour.
//                          Party colours default to the usual UK party colours when the CSV has no Colour column.
//   --name-property <p>    Constituency name property (default PCON24NM).
//   --line-class <c>       Class for every line in the NEXT input file: mainline | branch
//                          (e.g. --line-class mainline mainlines.geojson --line-class branch branches.geojson).
//   --precision <n>        Decimal places kept (default 5 ≈ 1 m).
//   --keep a,b,c           Only keep these properties (plus the ones this script adds).
//
// Simplify full-resolution boundaries first, or use the ONS "BUC" (ultra generalised) file:
//   npx mapshaper in.geojson -simplify 8% keep-shapes -o out.geojson
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const PARTY_COLOURS = {
    "labour": "#E4003B", "labour and co-operative": "#E4003B", "lab": "#E4003B",
    "conservative": "#0087DC", "con": "#0087DC",
    "liberal democrat": "#FAA61A", "liberal democrats": "#FAA61A", "ld": "#FAA61A",
    "scottish national party": "#FDF38E", "snp": "#FDF38E",
    "green": "#02A95B", "green party": "#02A95B",
    "reform uk": "#12B6CF", "reform": "#12B6CF",
    "plaid cymru": "#005B54", "pc": "#005B54",
    "sinn féin": "#326760", "sinn fein": "#326760", "sf": "#326760",
    "democratic unionist party": "#D46A4C", "dup": "#D46A4C",
    "social democratic and labour party": "#2AA82C", "sdlp": "#2AA82C",
    "alliance": "#F6CB2F", "alliance party": "#F6CB2F",
    "ulster unionist party": "#48A5EE", "uup": "#48A5EE",
    "traditional unionist voice": "#0C3A6A", "tuv": "#0C3A6A",
    "independent": "#9AA0A6", "ind": "#9AA0A6",
    "speaker": "#6E6E6E", "spk": "#6E6E6E"
};

const argv = process.argv.slice(2);
const inputs = [];
const opts = { precision: 5, nameProperty: "PCON24NM", keep: null, parties: null };
let pendingClass = null;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--precision") opts.precision = Number(argv[++i]);
    else if (a === "--name-property") opts.nameProperty = argv[++i];
    else if (a === "--keep") opts.keep = argv[++i].split(",").map(s => s.trim()).filter(Boolean);
    else if (a === "--parties") opts.parties = argv[++i];
    else if (a === "--line-class") pendingClass = argv[++i];
    else { inputs.push({ path: a, lineClass: pendingClass }); pendingClass = null; }
}
if (!inputs.length) {
    console.error("Usage: npm run prepare-geojson -- <file.geojson> [more.geojson …] [--parties ge2024.csv] [--line-class mainline|branch <file>] [--precision 5] [--keep a,b]");
    process.exit(1);
}

const factor = 10 ** opts.precision;
const round = coords => typeof coords[0] === "number"
    ? coords.map(v => Math.round(v * factor) / factor)
    : coords.map(round).filter((c, i, arr) => typeof c[0] !== "number" || i === 0 || c[0] !== arr[i - 1][0] || c[1] !== arr[i - 1][1]);

let maxAbs = 0;
const visit = c => typeof c[0] === "number" ? (maxAbs = Math.max(maxAbs, Math.abs(c[0]), Math.abs(c[1]))) : c.forEach(visit);

// ---- party CSV --------------------------------------------------------------------------
function parseCsv(text) {
    const rows = [];
    let row = [], field = "", quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
            else if (ch === '"') quoted = false;
            else field += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ",") { row.push(field); field = ""; }
        else if (ch === "\n" || ch === "\r") {
            if (ch === "\r" && text[i + 1] === "\n") i++;
            row.push(field); field = "";
            if (row.some(v => v !== "")) rows.push(row);
            row = [];
        } else field += ch;
    }
    row.push(field);
    if (row.some(v => v !== "")) rows.push(row);
    return rows;
}

const norm = s => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
let parties = null;
if (opts.parties) {
    const [header, ...rows] = parseCsv(readFileSync(opts.parties, "utf8").replace(/^﻿/, ""));
    const find = (...names) => header.findIndex(h => names.includes(norm(h)));
    const nameCol = find("pcon24nm", "constituency", "constituency name", "name");
    const partyCol = find("party", "first party", "winning party", "party name");
    const mpCol = find("mp", "mp name", "mp_name", "member");
    const colourCol = find("colour", "color", "fill", "party colour");
    if (nameCol < 0 || partyCol < 0) throw new Error(`--parties CSV needs a constituency column and a Party column; got: ${header.join(", ")}`);
    parties = new Map(rows.map(r => [norm(r[nameCol]), {
        party: r[partyCol]?.trim(),
        mp: mpCol >= 0 ? r[mpCol]?.trim() : undefined,
        colour: colourCol >= 0 && /^#[0-9a-f]{6}$/i.test(r[colourCol]?.trim() ?? "") ? r[colourCol].trim() : undefined
    }]));
}

// ---- merge ------------------------------------------------------------------------------
const counts = {};
const unmatched = [];
const features = [];
for (const input of inputs) {
    const fc = JSON.parse(readFileSync(input.path, "utf8"));
    if (fc.type !== "FeatureCollection" || !Array.isArray(fc.features)) throw new Error(`${input.path} is not a GeoJSON FeatureCollection`);
    for (const f of fc.features) {
        if (!f?.geometry) continue;
        const type = f.geometry.type;
        counts[type] = (counts[type] ?? 0) + 1;
        visit(f.geometry.coordinates);
        let properties = { ...(f.properties ?? {}) };
        if (opts.keep) properties = Object.fromEntries(Object.entries(properties).filter(([k]) => opts.keep.includes(k)));

        if ((type === "Polygon" || type === "MultiPolygon") && parties) {
            const name = f.properties?.[opts.nameProperty] ?? f.properties?.name;
            const match = parties.get(norm(name));
            if (match) {
                const colour = match.colour ?? PARTY_COLOURS[norm(match.party)] ?? PARTY_COLOURS.independent;
                properties = { ...properties, [opts.nameProperty]: name, Party: match.party, fill: colour, stroke: colour };
                if (match.mp) properties.MP_Name = match.mp;
            } else {
                unmatched.push(name);
            }
        }
        if ((type === "LineString" || type === "MultiLineString") && input.lineClass) {
            properties = { ...properties, line_class: input.lineClass };
        }
        features.push({ type: "Feature", properties, geometry: { type, coordinates: round(f.geometry.coordinates) } });
    }
}
if (maxAbs > 180) throw new Error("Coordinates look projected (e.g. British National Grid). Reproject to WGS84 (EPSG:4326) first, e.g. npx mapshaper in.geojson -proj wgs84 -o out.geojson");

mkdirSync("src/data", { recursive: true });
const json = JSON.stringify({ type: "FeatureCollection", features });
writeFileSync("src/data/combined_layers.json", json);
console.log(`Wrote src/data/combined_layers.json: ${features.length} features ${JSON.stringify(counts)}, ${(json.length / 1048576).toFixed(2)} MB`);
if (unmatched.length) console.warn(`Warning: ${unmatched.length} constituencies not found in ${opts.parties}: ${unmatched.slice(0, 10).join("; ")}${unmatched.length > 10 ? " …" : ""}`);
if (json.length > 8 * 1048576) console.warn("Warning: over 8 MB. Simplify the polygons (mapshaper, or use the ONS BUC file) so the visual loads quickly.");
