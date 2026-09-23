"use strict";

import maplibregl from "./maplibre";
import type { Map as MapLibreMap, FilterSpecification, LayerSpecification, SourceSpecification, StyleSpecification } from "maplibre-gl";

import { GLYPH_RANGES } from "./glyphs.generated";
import { VisualFormattingSettingsModel } from "./settings";

export const FONT = ["Open Sans Semibold"];
const GLYPH_PROTOCOL = "dftoglyphs";
const GLYPHS_URL = `${GLYPH_PROTOCOL}://{fontstack}/{range}`;

export const SRC = {
    polygons: "dfto-constituencies",
    labels: "dfto-constituency-labels",
    lines: "dfto-rail",
    stations: "dfto-stations",
    radius: "dfto-radius"
} as const;

export const LAYER = {
    constituencyFill: "dfto-constituency-fill",
    constituencyLine: "dfto-constituency-line",
    constituencySelected: "dfto-constituency-selected",
    constituencyHover: "dfto-constituency-hover",
    lineHover: "dfto-rail-hover",
    lineSelected: "dfto-rail-selected",
    branch: "dfto-rail-branch",
    mainline: "dfto-rail-mainline",
    radiusFill: "dfto-radius-fill",
    radiusLine: "dfto-radius-line",
    constituencyLabel: "dfto-constituency-label",
    stations: "dfto-stations",
    stationLabel: "dfto-station-label"
} as const;

/** Only these styles are reachable: their host is declared in capabilities.json → privileges → WebAccess. */
const REMOTE_STYLES: Record<string, string> = {
    positron: "https://tiles.openfreemap.org/styles/positron",
    dark: "https://tiles.openfreemap.org/styles/dark",
    liberty: "https://tiles.openfreemap.org/styles/liberty"
};

let glyphProtocolRegistered = false;

/** Base-map layers the style itself ships hidden; never force these visible. */
const originallyHidden = new Set<string>();

/**
 * Serves label glyphs from the bundle instead of the internet, for every font stack the style asks for.
 * Keeps the visual fully functional (labels included) with no WebAccess privilege at all.
 */
export function registerBundledGlyphs(): void {
    if (glyphProtocolRegistered) return;
    glyphProtocolRegistered = true;
    const cache = new Map<string, ArrayBuffer>();
    maplibregl.addProtocol(GLYPH_PROTOCOL, async (params) => {
        const range = params.url.split("/").pop() ?? "";
        let data = cache.get(range);
        if (!data) {
            const base64 = GLYPH_RANGES[range];
            data = base64 ? decodeBase64(base64) : new ArrayBuffer(0);
            cache.set(range, data);
        }
        return { data: data.slice(0) };
    });
}

function decodeBase64(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes.buffer;
}

/** The URL (or inline style) for the selected base map. */
export function resolveBaseStyle(settings: VisualFormattingSettingsModel): string | StyleSpecification {
    const key = String(settings.baseMap.style.value?.value ?? "blank");
    if (key === "custom") {
        const url = settings.baseMap.customUrl.value?.trim();
        if (url) return url;
    }
    return REMOTE_STYLES[key] ?? blankStyle(settings.baseMap.background.value.value);
}

export function baseStyleKey(settings: VisualFormattingSettingsModel): string {
    const style = resolveBaseStyle(settings);
    return typeof style === "string" ? style : "blank";
}

export function blankStyle(background: string): StyleSpecification {
    return {
        version: 8,
        sources: {},
        layers: [{ id: "dfto-background", type: "background", paint: { "background-color": background } }]
    };
}

const ROAD_SOURCE_LAYERS = new Set(["transportation", "transportation_name", "road", "roads", "road_label", "highway", "aeroway"]);
const ROAD_ID = /(road|street|highway|motorway|trunk|primary|secondary|tertiary|minor|service|track|path|bridge|tunnel|ferry|aeroway|transport|oneway|shield)/i;

export function isRoadLayer(layer: LayerSpecification): boolean {
    const sourceLayer = (layer as { "source-layer"?: string })["source-layer"];
    return (sourceLayer !== undefined && ROAD_SOURCE_LAYERS.has(sourceLayer)) || (!layer.id.startsWith("dfto-") && ROAD_ID.test(layer.id));
}

export function isBaseLabelLayer(layer: LayerSpecification): boolean {
    return layer.type === "symbol" && !layer.id.startsWith("dfto-");
}

export interface OverlayState {
    selectedConstituency: string | null;
    selectedLine: string | null;
    hoveredConstituency: string | null;
    hoveredLine: string | null;
    hasDimmed: boolean;
}

const NONE = "\u0000";

/** Filters for the hover / selection highlight layers; also pushed on their own when only the hover changes. */
export function highlightFilters(state: OverlayState): Record<string, FilterSpecification> {
    return {
        [LAYER.constituencyHover]: ["==", ["get", "__name"], state.hoveredConstituency ?? NONE],
        [LAYER.constituencySelected]: ["==", ["get", "__name"], state.selectedConstituency ?? NONE],
        [LAYER.lineHover]: ["==", ["get", "__name"], state.hoveredLine ?? NONE],
        [LAYER.lineSelected]: ["==", ["get", "__name"], state.selectedLine ?? NONE]
    };
}

/**
 * Every overlay layer, fully styled from the current settings. Used both to build a style
 * (initial load / base-map switch) and to push paint/layout changes on each update.
 */
export function overlayLayers(s: VisualFormattingSettingsModel, state: OverlayState): LayerSpecification[] {
    const vis = (on: boolean) => (on ? "visible" : "none") as "visible" | "none";
    const c = s.constituencies;
    const fallback = c.defaultColour.value.value;
    const fillColour = c.useGeoJsonColours.value ? ["coalesce", ["get", "__fill"], fallback] : fallback;
    const strokeColour = c.useGeoJsonColours.value ? ["coalesce", ["get", "__stroke"], fallback] : fallback;
    const filters = highlightFilters(state);
    const rail = s.railLines;
    const showMain = rail.show.value && rail.showMainlines.value;
    const showBranch = rail.show.value && rail.showBranches.value;
    const st = s.stations;
    const opacity = st.opacity.value / 100;
    const lbl = s.constituencyLabels;
    const radius = s.radiusCircle;
    const fillOpacity = c.fillOpacity.value / 100;
    const lineWidth = ["match", ["get", "__class"], "mainline", rail.mainlineWidth.value, rail.branchWidth.value];

    return [
        {
            id: LAYER.constituencyFill, type: "fill", source: SRC.polygons,
            layout: { visibility: vis(c.show.value) },
            paint: { "fill-color": fillColour as never, "fill-opacity": fillOpacity }
        },
        {
            id: LAYER.constituencyHover, type: "fill", source: SRC.polygons, filter: filters[LAYER.constituencyHover],
            layout: { visibility: vis(c.show.value && c.hoverHighlight.value) },
            paint: { "fill-color": fillColour as never, "fill-opacity": Math.min(1, fillOpacity + 0.3) }
        },
        {
            id: LAYER.constituencyLine, type: "line", source: SRC.polygons,
            layout: { visibility: vis(c.show.value), "line-join": "round" },
            paint: { "line-color": strokeColour as never, "line-width": c.strokeWidth.value, "line-opacity": c.strokeOpacity.value / 100 }
        },
        {
            id: LAYER.constituencySelected, type: "line", source: SRC.polygons, filter: filters[LAYER.constituencySelected],
            layout: { visibility: vis(c.show.value), "line-join": "round" },
            paint: { "line-color": strokeColour as never, "line-width": Math.max(3, c.strokeWidth.value * 3) }
        },
        {
            id: LAYER.lineSelected, type: "line", source: SRC.lines, filter: filters[LAYER.lineSelected],
            layout: { visibility: vis(rail.show.value), "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#FFD400", "line-width": ["+", lineWidth, 8] as never, "line-opacity": 0.85 }
        },
        {
            id: LAYER.lineHover, type: "line", source: SRC.lines, filter: filters[LAYER.lineHover],
            layout: { visibility: vis(rail.show.value && rail.hoverHighlight.value), "line-cap": "round", "line-join": "round" },
            paint: { "line-color": "#00A3FF", "line-width": ["+", lineWidth, 6] as never, "line-opacity": 0.55 }
        },
        {
            id: LAYER.branch, type: "line", source: SRC.lines, filter: ["==", ["get", "__class"], "branch"],
            layout: { visibility: vis(showBranch), "line-cap": "round", "line-join": "round" },
            paint: {
                "line-color": rail.branchColour.value.value,
                "line-width": rail.branchWidth.value,
                "line-dasharray": rail.dashBranches.value ? [3, 2] : [1, 0]
            }
        },
        {
            id: LAYER.mainline, type: "line", source: SRC.lines, filter: ["==", ["get", "__class"], "mainline"],
            layout: { visibility: vis(showMain), "line-cap": "round", "line-join": "round" },
            paint: { "line-color": rail.mainlineColour.value.value, "line-width": rail.mainlineWidth.value }
        },
        {
            id: LAYER.radiusFill, type: "fill", source: SRC.radius,
            layout: { visibility: vis(radius.show.value) },
            paint: { "fill-color": radius.colour.value.value, "fill-opacity": radius.fillOpacity.value / 100 }
        },
        {
            id: LAYER.radiusLine, type: "line", source: SRC.radius,
            layout: { visibility: vis(radius.show.value) },
            paint: { "line-color": radius.colour.value.value, "line-width": 1.5, "line-dasharray": [4, 2] }
        },
        {
            id: LAYER.constituencyLabel, type: "symbol", source: SRC.labels, minzoom: lbl.minZoom.value,
            layout: {
                visibility: vis(c.show.value && lbl.show.value),
                "text-field": ["get", "__name"],
                "text-font": FONT,
                // Grows with zoom so names stay readable nationally and in dense urban areas.
                "text-size": ["interpolate", ["linear"], ["zoom"], 5, lbl.fontSize.value * 0.8, 8, lbl.fontSize.value, 11, lbl.fontSize.value * 1.4],
                "text-max-width": 7,
                "text-padding": 1,
                // Larger constituencies claim their label space first.
                "symbol-sort-key": ["-", 0, ["get", "__area"]]
            },
            paint: { "text-color": lbl.colour.value.value, "text-halo-color": lbl.haloColour.value.value, "text-halo-width": 1.6 }
        },
        {
            id: LAYER.stations, type: "circle", source: SRC.stations,
            layout: { visibility: vis(st.show.value), "circle-sort-key": ["get", "selected"] },
            paint: {
                "circle-radius": ["case", ["==", ["get", "selected"], 1], st.radius.value * 1.4, st.radius.value],
                "circle-color": ["get", "colour"],
                "circle-opacity": state.hasDimmed ? ["case", ["==", ["get", "dim"], 1], opacity * 0.25, opacity] : opacity,
                "circle-stroke-color": st.strokeColour.value.value,
                "circle-stroke-width": st.strokeWidth.value,
                "circle-stroke-opacity": state.hasDimmed ? ["case", ["==", ["get", "dim"], 1], 0.25, 1] : 1
            }
        },
        {
            id: LAYER.stationLabel, type: "symbol", source: SRC.stations, minzoom: st.labelMinZoom.value,
            layout: {
                visibility: vis(st.show.value && st.showLabels.value),
                "text-field": ["get", "name"],
                "text-font": FONT,
                "text-size": 11,
                "text-offset": [0, 1.1],
                "text-anchor": "top",
                "text-optional": true
            },
            paint: { "text-color": "#333333", "text-halo-color": "#FFFFFF", "text-halo-width": 1.2 }
        }
    ];
}

/** Adds the overlay sources and layers to a base style, and repoints glyphs at the bundled fonts. */
export function composeStyle(
    base: StyleSpecification,
    sources: Record<string, SourceSpecification>,
    layers: LayerSpecification[],
    settings: VisualFormattingSettingsModel
): StyleSpecification {
    const hideRoads = settings.baseMap.hideRoads.value;
    const hideLabels = settings.baseMap.hideLabels.value;
    const baseLayers = base.layers
        .filter(l => !l.id.startsWith("dfto-") || l.id === "dfto-background")
        .map(l => {
            if ((l.layout as { visibility?: string } | undefined)?.visibility === "none") originallyHidden.add(l.id);
            const hidden = (hideRoads && isRoadLayer(l)) || (hideLabels && isBaseLabelLayer(l));
            return hidden ? { ...l, layout: { ...(l.layout ?? {}), visibility: "none" } } as LayerSpecification : l;
        });
    return {
        ...base,
        glyphs: GLYPHS_URL,
        sources: { ...base.sources, ...sources },
        layers: [...baseLayers, ...layers]
    };
}

/** Pushes changed paint/layout/filter/zoom-range values onto existing layers. */
export function applyLayerSpecs(map: MapLibreMap, layers: LayerSpecification[]): void {
    for (const layer of layers) {
        if (!map.getLayer(layer.id)) continue;
        for (const [key, value] of Object.entries(layer.paint ?? {})) map.setPaintProperty(layer.id, key, value);
        for (const [key, value] of Object.entries(layer.layout ?? {})) map.setLayoutProperty(layer.id, key, value);
        if ("filter" in layer && layer.filter) map.setFilter(layer.id, layer.filter);
        map.setLayerZoomRange(layer.id, layer.minzoom ?? 0, layer.maxzoom ?? 24);
    }
}

/** Shows/hides base-map roads and labels without reloading the style. */
export function applyBaseLayerVisibility(map: MapLibreMap, settings: VisualFormattingSettingsModel): void {
    for (const layer of map.getStyle()?.layers ?? []) {
        if (layer.id.startsWith("dfto-")) continue;
        const road = isRoadLayer(layer);
        const label = isBaseLabelLayer(layer);
        if ((!road && !label) || originallyHidden.has(layer.id)) continue;
        const hidden = (road && settings.baseMap.hideRoads.value) || (label && settings.baseMap.hideLabels.value);
        map.setLayoutProperty(layer.id, "visibility", hidden ? "none" : "visible");
    }
    if (map.getLayer("dfto-background")) {
        map.setPaintProperty("dfto-background", "background-color", settings.baseMap.background.value.value);
    }
}
