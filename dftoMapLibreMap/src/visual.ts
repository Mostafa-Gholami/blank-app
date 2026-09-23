/*
 *  DFTO Rail Map — MapLibre GL custom visual for Power BI.
 *  Fishbone Solutions. MIT License.
 */
"use strict";

import powerbi from "powerbi-visuals-api";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import type { FeatureCollection, Point, Polygon } from "geojson";
import type { GeoJSONSource, Map as MapLibreMap, MapMouseEvent, MapGeoJSONFeature, StyleSpecification } from "maplibre-gl";
import type { IBasicFilter, IFilterColumnTarget } from "powerbi-models";
import "./../style/visual.less";

import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import IVisualEventService = powerbi.extensibility.IVisualEventService;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;
import FilterAction = powerbi.FilterAction;

import combinedLayers from "./data/combined_layers.json";
import maplibregl from "./maplibre";
import { ParsedData, Station, parseDataView } from "./data";
import { Bounds, ReferenceLayers, buildReferenceLayers, circlePolygon, extend, geometryBounds, unionBounds } from "./geo";
import {
    LAYER, OverlayState, SRC, applyBaseLayerVisibility, applyLayerSpecs, baseStyleKey, blankStyle, composeStyle,
    highlightFilters, overlayLayers, registerBundledGlyphs, resolveBaseStyle
} from "./mapStyle";
import { VisualFormattingSettingsModel } from "./settings";

/** Great Britain, used until data or reference layers give a better frame. */
const GB_BOUNDS: Bounds = [-8.2, 49.9, 1.8, 58.7];
const BASEMAP_TIMEOUT_MS = 10000;
const LEGEND_MAX_ITEMS = 16;
/** Rail lines are thin, so hovering/clicking within this many pixels counts as a hit. */
const LINE_HIT_PX = 5;

export class Visual implements IVisual {
    private readonly host: IVisualHost;
    private readonly events: IVisualEventService;
    private readonly selectionManager: ISelectionManager;
    private readonly formattingSettingsService = new FormattingSettingsService();
    private settings = new VisualFormattingSettingsModel();

    private readonly root: HTMLElement;
    private readonly legendEl: HTMLElement;
    private readonly noticeEl: HTMLElement;
    private readonly layerPanelEl: HTMLElement;
    private readonly map: MapLibreMap;

    private reference: ReferenceLayers;
    private referenceNameProperty = "PCON24NM";
    private referenceLineNameProperty = "";
    private data: ParsedData = parseDataView(undefined, null);
    private visibleStations: Station[] = [];
    private stationByKey = new Map<string, Station>();
    private selectedConstituency: string | null = null;
    private selectedLine: string | null = null;
    private hoveredConstituency: string | null = null;
    private hoveredLine: string | null = null;

    private styleKey = "blank";
    private styleReady = false;
    private styleTimer: number | undefined;
    private baseMapWarning: string | null = null;
    /** Remote style that failed to load; not retried until the user picks a different base map. */
    private failedStyleKey: string | null = null;
    private lastFitSignature: string | null = null;
    private hoverKey: string | null = null;

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.events = options.host.eventService;
        this.selectionManager = options.host.createSelectionManager();
        this.root = options.element;
        this.root.classList.add("dfto-map-visual");

        const mapEl = this.createElement("div", "dfto-map");
        this.legendEl = this.createElement("div", "dfto-legend");
        this.noticeEl = this.createElement("div", "dfto-notice");
        this.layerPanelEl = this.createElement("div", "dfto-layer-panel");

        registerBundledGlyphs();
        this.reference = buildReferenceLayers(combinedLayers as FeatureCollection, this.referenceNameProperty);

        this.map = new maplibregl.Map({
            container: mapEl,
            style: this.composeStyle(resolveBaseStyle(this.settings) as StyleSpecification),
            bounds: this.reference.bounds ?? GB_BOUNDS,
            fitBoundsOptions: { padding: 20 },
            attributionControl: { compact: true },
            dragRotate: false,
            pitchWithRotate: false,
            touchPitch: false,
            maxPitch: 0,
            fadeDuration: 0
        });
        this.map.touchZoomRotate.disableRotation();
        this.map.keyboard.disableRotation();
        this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

        this.map.on("style.load", () => this.onStyleLoaded());
        this.map.on("error", (e) => this.onMapError(e.error));
        this.map.on("mousemove", (e) => this.onMouseMove(e));
        this.map.getCanvas().addEventListener("mouseleave", () => this.onMouseLeave());
        this.map.on("click", (e) => this.onClick(e));
        this.map.on("contextmenu", (e) => this.onContextMenu(e));
        this.selectionManager.registerOnSelectCallback(() => this.render());
    }

    public update(options: VisualUpdateOptions): void {
        this.events.renderingStarted(options);
        try {
            const dataView = options.dataViews?.[0];
            this.settings = this.formattingSettingsService.populateFormattingSettingsModel(VisualFormattingSettingsModel, dataView);
            this.data = parseDataView(dataView, this.host);
            const jsonFilters = options.jsonFilters as IBasicFilter[] | undefined;
            this.selectedConstituency = this.readFilter(jsonFilters, this.data.constituencyTarget);
            this.selectedLine = this.readFilter(jsonFilters, this.data.mainlineTarget);

            const nameProperty = this.settings.constituencies.nameProperty.value?.trim() || "PCON24NM";
            const lineNameProperty = this.settings.railLines.nameProperty.value?.trim() ?? "";
            if (nameProperty !== this.referenceNameProperty || lineNameProperty !== this.referenceLineNameProperty) {
                this.referenceNameProperty = nameProperty;
                this.referenceLineNameProperty = lineNameProperty;
                this.reference = buildReferenceLayers(combinedLayers as FeatureCollection, nameProperty, lineNameProperty);
                this.setSourceData(SRC.polygons, this.reference.polygons);
                this.setSourceData(SRC.labels, this.reference.labels);
                this.setSourceData(SRC.lines, this.reference.lines);
            }

            this.map.resize();
            const nextStyleKey = baseStyleKey(this.settings);
            if (nextStyleKey !== this.failedStyleKey) this.failedStyleKey = null;
            if (nextStyleKey !== this.styleKey && nextStyleKey !== this.failedStyleKey) {
                this.switchBaseMap(nextStyleKey);
            } else {
                this.render();
            }
            this.finishRenderingWhenIdle(options);
        } catch (error) {
            console.error("DFTO map update failed", error);
            this.events.renderingFailed(options, String(error));
        }
    }

    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.formattingSettingsService.buildFormattingModel(this.settings);
    }

    public destroy(): void {
        window.clearTimeout(this.styleTimer);
        this.map.remove();
    }

    // ---------------------------------------------------------------- base map

    private composeStyle(base: StyleSpecification): StyleSpecification {
        const sources = {
            [SRC.polygons]: { type: "geojson" as const, data: this.reference.polygons },
            [SRC.labels]: { type: "geojson" as const, data: this.reference.labels },
            [SRC.lines]: { type: "geojson" as const, data: this.reference.lines },
            [SRC.stations]: { type: "geojson" as const, data: this.stationFeatures().collection },
            [SRC.radius]: { type: "geojson" as const, data: this.radiusFeatures() }
        };
        return composeStyle(base, sources, overlayLayers(this.settings, this.overlayState(false)), this.settings);
    }

    private switchBaseMap(styleKey: string): void {
        this.styleKey = styleKey;
        this.styleReady = false;
        this.baseMapWarning = null;
        window.clearTimeout(this.styleTimer);
        const style = resolveBaseStyle(this.settings);
        if (typeof style !== "string") {
            this.map.setStyle(this.composeStyle(style), { diff: false });
        } else {
            this.map.setStyle(style, { diff: false, transformStyle: (_previous, next) => this.composeStyle(next) });
            // A remote style that never arrives (WebAccess blocked by tenant admin, offline) must not leave the overlay missing.
            this.styleTimer = window.setTimeout(() => this.fallBackToOfflineBaseMap("timed out"), BASEMAP_TIMEOUT_MS);
        }
    }

    private onStyleLoaded(): void {
        window.clearTimeout(this.styleTimer);
        this.styleReady = true;
        this.render();
    }

    private onMapError(error: Error | undefined): void {
        if (!this.styleReady && this.styleKey !== "blank") {
            // Defer: replacing the style from inside MapLibre's own style-load error handler leaves it half-loaded.
            window.setTimeout(() => this.fallBackToOfflineBaseMap(error?.message ?? "failed to load"), 0);
        }
    }

    private fallBackToOfflineBaseMap(reason: string): void {
        if (this.styleReady || this.styleKey === "blank") return;
        console.warn(`DFTO map: base map ${this.styleKey} ${reason}; using the offline base map`);
        window.clearTimeout(this.styleTimer);
        this.failedStyleKey = this.styleKey;
        this.styleKey = "blank";
        // No transformStyle here: MapLibre serialises the previous (never-loaded) style for it, which fails.
        this.map.setStyle(this.composeStyle(blankStyle(this.settings.baseMap.background.value.value)), { diff: false });
        this.baseMapWarning = "Base map unavailable (network access blocked?) – showing the offline map.";
    }

    // ---------------------------------------------------------------- render

    private render(): void {
        if (!this.styleReady) return;
        const stations = this.stationFeatures();
        this.setSourceData(SRC.stations, stations.collection);
        this.setSourceData(SRC.radius, this.radiusFeatures());
        applyLayerSpecs(this.map, overlayLayers(this.settings, this.overlayState(stations.hasDimmed)));
        applyBaseLayerVisibility(this.map, this.settings);
        this.renderLegend();
        this.renderLayerPanel();
        this.renderNotice();
        this.zoomToData();
    }

    private overlayState(hasDimmed: boolean): OverlayState {
        return {
            selectedConstituency: this.selectedConstituency,
            selectedLine: this.selectedLine,
            hoveredConstituency: this.hoveredConstituency,
            hoveredLine: this.hoveredLine,
            hasDimmed
        };
    }

    /** Hover only moves the highlight layers' filters, so it never re-uploads data. */
    private applyHighlights(): void {
        if (!this.styleReady) return;
        for (const [id, filter] of Object.entries(highlightFilters(this.overlayState(false)))) {
            if (this.map.getLayer(id)) this.map.setFilter(id, filter);
        }
    }

    private stationFeatures(): { collection: FeatureCollection<Point>; hasDimmed: boolean } {
        const st = this.settings.stations;
        const onlyInRadius = st.onlyInRadius.value && this.data.hasInRadius;
        const mainlineFilter = String(st.stationFilter.value?.value ?? "all");
        this.visibleStations = this.data.stations.filter(s =>
            (!onlyInRadius || s.inRadius) &&
            (mainlineFilter === "all" || s.isMainline === null || s.isMainline === (mainlineFilter === "mainline")));
        this.stationByKey = new Map(this.visibleStations.map(s => [s.key, s]));

        const selected = this.selectionManager.getSelectionIds() as ISelectionId[];
        const isSelected = (s: Station) => selected.some(id => s.selectionId.equals(id));
        const colourOf = this.stationColourResolver();
        let hasDimmed = false;

        const features = this.visibleStations.map(s => {
            const sel = selected.length > 0 && isSelected(s);
            const dim = selected.length > 0 ? !sel : s.highlighted === false;
            hasDimmed ||= dim;
            return {
                type: "Feature" as const,
                geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
                properties: { key: s.key, name: s.name, colour: colourOf(s), selected: sel ? 1 : 0, dim: dim ? 1 : 0 }
            };
        });
        return { collection: { type: "FeatureCollection", features }, hasDimmed };
    }

    private radiusFeatures(): FeatureCollection<Polygon> {
        const r = this.data.radius;
        return { type: "FeatureCollection", features: r ? [circlePolygon(r.lat, r.lon, r.miles)] : [] };
    }

    private colourByMainline(): boolean {
        return this.data.hasMainline && this.settings.stations.colourBy.value?.value === "mainline";
    }

    private stationColourResolver(): (s: Station) => string {
        const st = this.settings.stations;
        if (this.colourByMainline()) {
            return s => s.isMainline ? st.mainlineStationColour.value.value : st.nonMainlineStationColour.value.value;
        }
        const ownerColour = this.ownerColourResolver();
        return s => ownerColour(s.facilityOwner);
    }

    /** SFO → colour: explicit overrides from the format pane, then the report theme palette. */
    private ownerColourResolver(): (owner: string | null) => string {
        const fallback = this.settings.stations.defaultColour.value.value;
        const overrides = new Map<string, string>();
        for (const entry of (this.settings.stations.colourOverrides.value ?? "").split(/[;\n]/)) {
            const eq = entry.lastIndexOf("=");
            if (eq <= 0) continue;
            const colour = entry.substring(eq + 1).trim();
            if (/^#[0-9a-f]{3,8}$/i.test(colour)) overrides.set(entry.substring(0, eq).trim().toLowerCase(), colour);
        }
        const palette = this.host.colorPalette;
        return (owner) => {
            if (!owner) return fallback;
            return overrides.get(owner.toLowerCase()) ?? palette.getColor(owner).value;
        };
    }

    private setSourceData(id: string, data: FeatureCollection): void {
        (this.map.getSource(id) as GeoJSONSource | undefined)?.setData(data);
    }

    // ---------------------------------------------------------------- legend, layer switcher, notice

    private renderLegend(): void {
        const legend = this.settings.legend;
        const st = this.settings.stations;
        const rail = this.settings.railLines;
        this.legendEl.replaceChildren();
        this.legendEl.className = `dfto-legend dfto-${String(legend.position.value?.value ?? "top-left")}`;

        const sections: HTMLElement[] = [];
        if (st.show.value && this.visibleStations.length > 0) {
            if (this.colourByMainline()) {
                sections.push(this.legendSection("Stations", [
                    this.legendRow(this.dot(st.mainlineStationColour.value.value), "Mainline station"),
                    this.legendRow(this.dot(st.nonMainlineStationColour.value.value), "Non-mainline station")
                ]));
            } else {
                const owners = Array.from(new Set(this.visibleStations.map(s => s.facilityOwner).filter((o): o is string => !!o))).sort();
                const colourOf = this.ownerColourResolver();
                const rows = owners.slice(0, LEGEND_MAX_ITEMS).map(o => this.legendRow(this.dot(colourOf(o)), o));
                if (owners.length > LEGEND_MAX_ITEMS) rows.push(this.textElement("div", "dfto-legend-more", `+${owners.length - LEGEND_MAX_ITEMS} more`));
                if (rows.length) sections.push(this.legendSection("Station Facility Owner", rows));
            }
        }
        if (rail.show.value && this.reference.lines.features.length > 0) {
            const rows: HTMLElement[] = [];
            if (rail.showMainlines.value) rows.push(this.legendRow(this.bar(rail.mainlineColour.value.value, rail.mainlineWidth.value, false), "Mainline"));
            if (rail.showBranches.value) rows.push(this.legendRow(this.bar(rail.branchColour.value.value, rail.branchWidth.value, rail.dashBranches.value), "Non-mainline (branch)"));
            if (rows.length) sections.push(this.legendSection("Rail lines", rows));
        }
        const visible = legend.show.value && sections.length > 0;
        this.legendEl.style.display = visible ? "" : "none";
        if (visible) this.legendEl.append(...sections);
    }

    private legendSection(title: string, rows: HTMLElement[]): HTMLElement {
        const section = this.textElement("div", "dfto-legend-section", "");
        section.append(this.textElement("div", "dfto-legend-title", title), ...rows);
        return section;
    }

    private legendRow(swatch: HTMLElement, label: string): HTMLElement {
        const row = this.textElement("div", "dfto-legend-row", "");
        row.append(swatch, document.createTextNode(label));
        return row;
    }

    private dot(colour: string): HTMLElement {
        const el = this.textElement("span", "dfto-legend-swatch", "");
        el.style.backgroundColor = colour;
        return el;
    }

    private bar(colour: string, width: number, dashed: boolean): HTMLElement {
        const el = this.textElement("span", "dfto-legend-line", "");
        el.style.borderTop = `${Math.max(1, Math.min(width, 6))}px ${dashed ? "dashed" : "solid"} ${colour}`;
        return el;
    }

    /** On-map checkboxes; each one writes the same property as its format-pane toggle, so both stay in sync. */
    private renderLayerPanel(): void {
        const s = this.settings;
        this.layerPanelEl.replaceChildren();
        // Keep clear of the legend when it sits in the same corner.
        this.layerPanelEl.classList.toggle("dfto-panel-top", s.legend.position.value?.value === "bottom-left");
        this.layerPanelEl.style.display = s.layerPanel.show.value ? "" : "none";
        if (!s.layerPanel.show.value) return;

        const hasLines = this.reference.lines.features.length > 0;
        const items: { label: string; slice: { value: boolean }; object: string; property: string; enabled: boolean }[] = [
            { label: "Constituencies", slice: s.constituencies.show, object: "constituencies", property: "show", enabled: true },
            { label: "Constituency names", slice: s.constituencyLabels.show, object: "constituencyLabels", property: "show", enabled: s.constituencies.show.value },
            { label: "Mainlines", slice: s.railLines.showMainlines, object: "railLines", property: "showMainlines", enabled: hasLines && s.railLines.show.value },
            { label: "Non-mainline lines", slice: s.railLines.showBranches, object: "railLines", property: "showBranches", enabled: hasLines && s.railLines.show.value },
            { label: "Stations", slice: s.stations.show, object: "stations", property: "show", enabled: this.data.stations.length > 0 }
        ];
        for (const item of items) {
            const label = this.textElement("label", "dfto-layer-item", "");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.checked = item.slice.value;
            box.disabled = !item.enabled;
            box.addEventListener("change", () => {
                item.slice.value = box.checked;
                this.render();
                this.host.persistProperties({ merge: [{ objectName: item.object, selector: null, properties: { [item.property]: box.checked } }] });
            });
            label.append(box, document.createTextNode(item.label));
            if (!item.enabled) label.classList.add("dfto-disabled");
            this.layerPanelEl.appendChild(label);
        }
    }

    private renderNotice(): void {
        const messages: string[] = [];
        if (this.baseMapWarning && this.failedStyleKey) messages.push(this.baseMapWarning);
        if (this.data.invalidCoordinates > 0) {
            messages.push(`${this.data.invalidCoordinates} station(s) skipped: latitude/longitude missing or not WGS84 degrees.`);
        }
        this.noticeEl.textContent = messages.join(" ");
        this.noticeEl.style.display = messages.length ? "" : "none";
    }

    // ---------------------------------------------------------------- zoom

    /** Reframes to the filtered stations (plus search circle / clicked constituency or line) whenever that set changes. */
    private zoomToData(): void {
        const zoom = this.settings.zoom;
        const r = this.data.radius;
        const signature = [
            this.visibleStations.map(s => s.key).join(";"),
            r ? `${r.lat},${r.lon},${r.miles}` : "",
            this.selectedConstituency ?? "",
            this.selectedLine ?? ""
        ].join("|");
        if (!zoom.autoZoom.value || signature === this.lastFitSignature) return;
        const firstFit = this.lastFitSignature === null;
        this.lastFitSignature = signature;

        let bounds: Bounds | null = null;
        for (const s of this.visibleStations) bounds = extend(bounds, s.lon, s.lat);
        if (r && this.settings.radiusCircle.show.value) bounds = unionBounds(bounds, geometryBounds(circlePolygon(r.lat, r.lon, r.miles).geometry));
        if (this.selectedConstituency) bounds = unionBounds(bounds, this.reference.boundsByName.get(this.selectedConstituency) ?? null);
        if (this.selectedLine) bounds = unionBounds(bounds, this.reference.boundsByLine.get(this.selectedLine) ?? null);
        bounds ??= this.reference.bounds ?? GB_BOUNDS;
        this.fitTo(bounds, firstFit ? 0 : 600);
    }

    private fitTo(bounds: Bounds, duration: number): void {
        const canvas = this.map.getCanvas();
        const maxPadding = Math.max(0, Math.min(canvas.clientWidth, canvas.clientHeight) / 2 - 10);
        const padding = Math.min(this.settings.zoom.padding.value, maxPadding);
        this.map.fitBounds(bounds, { padding, maxZoom: this.settings.zoom.maxZoom.value, duration });
    }

    // ---------------------------------------------------------------- interaction

    /** What is under the pointer, in priority order: station, then rail line (with a few px of slack), then constituency. */
    private hit(e: MapMouseEvent): { station?: Station; line?: MapGeoJSONFeature; constituency?: MapGeoJSONFeature } {
        const present = (ids: string[]) => ids.filter(id => this.map.getLayer(id) && this.map.getLayoutProperty(id, "visibility") !== "none");
        const { x, y } = e.point;
        const box = (px: number): [[number, number], [number, number]] => [[x - px, y - px], [x + px, y + px]];

        const stationLayers = present([LAYER.stations]);
        const stationFeature = stationLayers.length ? this.map.queryRenderedFeatures(box(2), { layers: stationLayers })[0] : undefined;
        const station = stationFeature ? this.stationByKey.get(String(stationFeature.properties.key)) : undefined;
        if (station) return { station };

        const lineLayers = present([LAYER.mainline, LAYER.branch]);
        const line = lineLayers.length ? this.map.queryRenderedFeatures(box(LINE_HIT_PX), { layers: lineLayers })[0] : undefined;
        if (line) return { line };

        const polygonLayers = present([LAYER.constituencyFill]);
        return { constituency: polygonLayers.length ? this.map.queryRenderedFeatures(e.point, { layers: polygonLayers })[0] : undefined };
    }

    private onMouseMove(e: MapMouseEvent): void {
        const { station, line, constituency } = this.hit(e);
        this.map.getCanvas().style.cursor = station || line || constituency ? "pointer" : "";

        const hoveredLine = line ? String(line.properties.__name ?? "") || null : null;
        const hoveredConstituency = constituency ? String(constituency.properties.__name ?? "") : null;
        if (hoveredLine !== this.hoveredLine || hoveredConstituency !== this.hoveredConstituency) {
            this.hoveredLine = hoveredLine;
            this.hoveredConstituency = hoveredConstituency;
            this.applyHighlights();
        }

        const hoverKey = station ? `s:${station.key}` : line ? `l:${hoveredLine ?? line.properties.__class}` : constituency ? `c:${hoveredConstituency}` : null;
        if (!hoverKey) {
            this.hideTooltip();
            return;
        }
        const coordinates = [e.point.x, e.point.y];
        const identities = station ? [station.selectionId] : [];
        if (hoverKey === this.hoverKey) {
            this.host.tooltipService.move({ coordinates, isTouchEvent: false, identities });
            return;
        }
        this.hoverKey = hoverKey;
        const dataItems = station ? station.tooltip : line ? this.lineTooltip(line) : this.constituencyTooltip(constituency);
        this.host.tooltipService.show({ coordinates, isTouchEvent: false, dataItems, identities });
    }

    private onMouseLeave(): void {
        this.hideTooltip();
        if (this.hoveredLine || this.hoveredConstituency) {
            this.hoveredLine = null;
            this.hoveredConstituency = null;
            this.applyHighlights();
        }
    }

    private constituencyTooltip(feature: MapGeoJSONFeature): VisualTooltipDataItem[] {
        const props = feature.properties;
        const name = String(props.__name ?? "");
        const items: VisualTooltipDataItem[] = [{ displayName: "Constituency", value: name }];
        const shown = new Set<string>();
        for (const key of (this.settings.constituencies.tooltipProperties.value ?? "").split(",").map(k => k.trim()).filter(Boolean)) {
            const value = props[key];
            if (value !== undefined && value !== null && value !== "") {
                items.push({ displayName: key, value: String(value) });
                shown.add(key.toLowerCase());
            }
        }
        const stations = this.visibleStations.filter(s => s.constituency === name);
        // MP / party can also come from the report data (e.g. MP_Name in Tooltip details).
        for (const item of stations[0]?.tooltip ?? []) {
            if (/\b(mp|party)\b|mp_name/i.test(item.displayName) && !shown.has(item.displayName.toLowerCase())) {
                items.push({ displayName: item.displayName, value: item.value });
                shown.add(item.displayName.toLowerCase());
            }
        }
        if (this.data.constituencyTarget) {
            items.push({ displayName: "Stations shown", value: String(stations.length) });
            if (this.data.hasMainline) items.push({ displayName: "Mainline stations", value: String(stations.filter(s => s.isMainline).length) });
        }
        if (this.data.constituencyTarget && this.host.hostCapabilities.allowInteractions) {
            items.push({ displayName: "", value: name === this.selectedConstituency ? "Click to clear the filter" : "Click to filter the report" });
        }
        return items;
    }

    private lineTooltip(feature: MapGeoJSONFeature): VisualTooltipDataItem[] {
        const name = String(feature.properties.__name ?? "");
        const isMain = feature.properties.__class === "mainline";
        const items: VisualTooltipDataItem[] = [];
        if (name) items.push({ displayName: "Line", value: name });
        items.push({ displayName: "Type", value: isMain ? "Mainline" : "Non-mainline (branch)" });
        if (name && this.data.hasMainline) {
            const onLine = this.visibleStations.filter(s => s.mainline?.toLowerCase() === name.toLowerCase());
            if (onLine.length) items.push({ displayName: "Stations shown on this line", value: String(onLine.length) });
        }
        if (name && this.host.hostCapabilities.allowInteractions) {
            const canFilter = this.data.mainlineTarget !== null;
            items.push({ displayName: "", value: canFilter ? (name === this.selectedLine ? "Click to clear the filter" : "Click to filter the report to this line") : "Click to zoom to this line" });
        }
        return items;
    }

    private hideTooltip(): void {
        if (this.hoverKey === null) return;
        this.hoverKey = null;
        this.host.tooltipService.hide({ isTouchEvent: false, immediately: true });
    }

    private onClick(e: MapMouseEvent): void {
        if (!this.host.hostCapabilities.allowInteractions) return;
        const { station, line, constituency } = this.hit(e);
        const original = e.originalEvent;
        if (station) {
            const multi = original.ctrlKey || original.metaKey || original.shiftKey;
            this.selectionManager.select(station.selectionId, multi).then(() => this.render());
            return;
        }
        this.selectionManager.clear().then(() => this.render());
        if (line) {
            this.toggleLine(String(line.properties.__name ?? ""));
        } else if (constituency) {
            this.toggleConstituency(String(constituency.properties.__name ?? ""));
        } else if (this.selectedConstituency || this.selectedLine) {
            this.applyFilters(null, null);
        }
    }

    private onContextMenu(e: MapMouseEvent): void {
        e.preventDefault();
        if (!this.host.hostCapabilities.allowInteractions) return;
        const { station } = this.hit(e);
        this.selectionManager.showContextMenu(station?.selectionId ?? ({} as ISelectionId), { x: e.originalEvent.clientX, y: e.originalEvent.clientY });
    }

    /** Clicking a polygon filters the report to that constituency; clicking it again clears the filter. */
    private toggleConstituency(name: string): void {
        if (!name) return;
        if (!this.data.constituencyTarget) {
            // No Constituency field bound, so nothing to filter on: just zoom to the polygon.
            const bounds = this.reference.boundsByName.get(name);
            if (bounds) this.fitTo(bounds, 600);
            return;
        }
        this.applyFilters(name === this.selectedConstituency ? null : name, this.selectedLine);
    }

    /** Clicking a line filters the report on the Mainline column to that line; clicking it again clears it. */
    private toggleLine(name: string): void {
        if (!name) return;
        if (!this.data.mainlineTarget) {
            const bounds = this.reference.boundsByLine.get(name);
            if (bounds) this.fitTo(bounds, 600);
            return;
        }
        this.applyFilters(this.selectedConstituency, name === this.selectedLine ? null : name);
    }

    private applyFilters(constituency: string | null, line: string | null): void {
        const filters: IBasicFilter[] = [];
        const basic = (target: IFilterColumnTarget, value: string): IBasicFilter => ({
            // eslint-disable-next-line powerbi-visuals/no-http-string -- fixed schema id defined by powerbi-models, not a URL that is fetched
            $schema: "http://powerbi.com/product/schema#basic",
            target,
            operator: "In",
            values: [value],
            filterType: 1 // models.FilterType.Basic
        });
        if (constituency && this.data.constituencyTarget) filters.push(basic(this.data.constituencyTarget, constituency));
        if (line && this.data.mainlineTarget) filters.push(basic(this.data.mainlineTarget, line));
        if (filters.length === 0) {
            this.host.applyJsonFilter(null, "general", "filter", FilterAction.remove);
        } else {
            this.host.applyJsonFilter(filters, "general", "filter", FilterAction.merge);
        }
    }

    /** Recovers which constituency / line this visual is filtering on from the filters Power BI hands back. */
    private readFilter(filters: IBasicFilter[] | undefined, target: IFilterColumnTarget | null): string | null {
        if (!target) return null;
        const filter = filters?.find(f => {
            const t = f?.target as IFilterColumnTarget | undefined;
            return t && t.table === target.table && t.column === target.column;
        });
        const values = filter?.values;
        return Array.isArray(values) && values.length === 1 ? String(values[0]) : null;
    }

    // ---------------------------------------------------------------- helpers

    private finishRenderingWhenIdle(options: VisualUpdateOptions): void {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            this.events.renderingFinished(options);
        };
        const timer = window.setTimeout(finish, 5000);
        this.map.once("idle", finish);
        this.map.triggerRepaint();
    }

    private createElement(tag: string, className: string): HTMLElement {
        const el = document.createElement(tag);
        el.className = className;
        this.root.appendChild(el);
        return el;
    }

    private textElement(tag: string, className: string, text: string): HTMLElement {
        const el = document.createElement(tag);
        el.className = className;
        el.textContent = text;
        return el;
    }
}
