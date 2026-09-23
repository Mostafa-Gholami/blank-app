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
    LAYER, SRC, applyBaseLayerVisibility, applyLayerSpecs, baseStyleKey, blankStyle, composeStyle, overlayLayers,
    registerBundledGlyphs, resolveBaseStyle
} from "./mapStyle";
import { VisualFormattingSettingsModel } from "./settings";

/** Great Britain, used until data or reference layers give a better frame. */
const GB_BOUNDS: Bounds = [-8.2, 49.9, 1.8, 58.7];
const BASEMAP_TIMEOUT_MS = 10000;
const LEGEND_MAX_ITEMS = 16;

export class Visual implements IVisual {
    private readonly host: IVisualHost;
    private readonly events: IVisualEventService;
    private readonly selectionManager: ISelectionManager;
    private readonly formattingSettingsService = new FormattingSettingsService();
    private settings = new VisualFormattingSettingsModel();

    private readonly root: HTMLElement;
    private readonly legendEl: HTMLElement;
    private readonly noticeEl: HTMLElement;
    private readonly map: MapLibreMap;

    private reference: ReferenceLayers;
    private referenceNameProperty = "PCON24NM";
    private data: ParsedData = parseDataView(undefined, null);
    private visibleStations: Station[] = [];
    private stationByKey = new Map<string, Station>();
    private selectedConstituency: string | null = null;

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
        this.map.getCanvas().addEventListener("mouseleave", () => this.hideTooltip());
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
            this.selectedConstituency = this.readConstituencyFilter(options.jsonFilters as IBasicFilter[] | undefined);

            const nameProperty = this.settings.constituencies.nameProperty.value?.trim() || "PCON24NM";
            if (nameProperty !== this.referenceNameProperty) {
                this.referenceNameProperty = nameProperty;
                this.reference = buildReferenceLayers(combinedLayers as FeatureCollection, nameProperty);
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
        this.renderNotice();
        this.zoomToData();
    }

    private overlayState(hasDimmed: boolean) {
        return { selectedConstituency: this.selectedConstituency, hasDimmed };
    }

    private stationFeatures(): { collection: FeatureCollection<Point>; hasDimmed: boolean } {
        const onlyInRadius = this.settings.stations.onlyInRadius.value && this.data.hasInRadius;
        this.visibleStations = onlyInRadius ? this.data.stations.filter(s => s.inRadius) : this.data.stations;
        this.stationByKey = new Map(this.visibleStations.map(s => [s.key, s]));

        const selected = this.selectionManager.getSelectionIds() as ISelectionId[];
        const isSelected = (s: Station) => selected.some(id => s.selectionId.equals(id));
        const colourOf = this.colourResolver();
        let hasDimmed = false;

        const features = this.visibleStations.map(s => {
            const sel = selected.length > 0 && isSelected(s);
            const dim = selected.length > 0 ? !sel : s.highlighted === false;
            hasDimmed ||= dim;
            return {
                type: "Feature" as const,
                geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
                properties: { key: s.key, name: s.name, colour: colourOf(s.facilityOwner), selected: sel ? 1 : 0, dim: dim ? 1 : 0 }
            };
        });
        return { collection: { type: "FeatureCollection", features }, hasDimmed };
    }

    private radiusFeatures(): FeatureCollection<Polygon> {
        const r = this.data.radius;
        return { type: "FeatureCollection", features: r ? [circlePolygon(r.lat, r.lon, r.miles)] : [] };
    }

    /** SFO → colour: explicit overrides from the format pane, then the report theme palette. */
    private colourResolver(): (owner: string | null) => string {
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

    private renderLegend(): void {
        const legend = this.settings.legend;
        const owners = Array.from(new Set(this.visibleStations.map(s => s.facilityOwner).filter((o): o is string => !!o))).sort();
        this.legendEl.replaceChildren();
        this.legendEl.className = `dfto-legend dfto-${String(legend.position.value?.value ?? "top-left")}`;
        this.legendEl.style.display = legend.show.value && this.settings.stations.show.value && owners.length > 0 ? "" : "none";
        if (this.legendEl.style.display === "none") return;

        const colourOf = this.colourResolver();
        this.legendEl.appendChild(this.textElement("div", "dfto-legend-title", "Station Facility Owner"));
        for (const owner of owners.slice(0, LEGEND_MAX_ITEMS)) {
            const row = this.textElement("div", "dfto-legend-row", "");
            const swatch = this.textElement("span", "dfto-legend-swatch", "");
            swatch.style.backgroundColor = colourOf(owner);
            row.append(swatch, document.createTextNode(owner));
            this.legendEl.appendChild(row);
        }
        if (owners.length > LEGEND_MAX_ITEMS) {
            this.legendEl.appendChild(this.textElement("div", "dfto-legend-more", `+${owners.length - LEGEND_MAX_ITEMS} more`));
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

    /** Reframes to the filtered stations (plus search circle / clicked constituency) whenever that set changes. */
    private zoomToData(): void {
        const zoom = this.settings.zoom;
        const r = this.data.radius;
        const signature = [
            this.visibleStations.map(s => s.key).join(";"),
            r ? `${r.lat},${r.lon},${r.miles}` : "",
            this.selectedConstituency ?? ""
        ].join("|");
        if (!zoom.autoZoom.value || signature === this.lastFitSignature) return;
        const firstFit = this.lastFitSignature === null;
        this.lastFitSignature = signature;

        let bounds: Bounds | null = null;
        for (const s of this.visibleStations) bounds = extend(bounds, s.lon, s.lat);
        if (r && this.settings.radiusCircle.show.value) bounds = unionBounds(bounds, geometryBounds(circlePolygon(r.lat, r.lon, r.miles).geometry));
        if (this.selectedConstituency) bounds = unionBounds(bounds, this.reference.boundsByName.get(this.selectedConstituency) ?? null);
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

    private hit(e: MapMouseEvent): { station?: Station; constituency?: MapGeoJSONFeature } {
        const layers = [LAYER.stations, LAYER.constituencyFill].filter(id => this.map.getLayer(id));
        const features = layers.length ? this.map.queryRenderedFeatures(e.point, { layers }) : [];
        const stationFeature = features.find(f => f.layer.id === LAYER.stations);
        return {
            station: stationFeature ? this.stationByKey.get(String(stationFeature.properties.key)) : undefined,
            constituency: features.find(f => f.layer.id === LAYER.constituencyFill)
        };
    }

    private onMouseMove(e: MapMouseEvent): void {
        const { station, constituency } = this.hit(e);
        this.map.getCanvas().style.cursor = station || constituency ? "pointer" : "";
        const hoverKey = station ? `s:${station.key}` : constituency ? `c:${constituency.properties.__name}` : null;
        if (!hoverKey) {
            this.hideTooltip();
            return;
        }
        const coordinates = [e.point.x, e.point.y];
        if (hoverKey === this.hoverKey) {
            this.host.tooltipService.move({ coordinates, isTouchEvent: false, identities: station ? [station.selectionId] : [] });
            return;
        }
        this.hoverKey = hoverKey;
        this.host.tooltipService.show({
            coordinates,
            isTouchEvent: false,
            dataItems: station ? station.tooltip : this.constituencyTooltip(constituency),
            identities: station ? [station.selectionId] : []
        });
    }

    private constituencyTooltip(feature: MapGeoJSONFeature): VisualTooltipDataItem[] {
        const props = feature.properties;
        const items: VisualTooltipDataItem[] = [{ displayName: "Constituency", value: String(props.__name ?? "") }];
        for (const key of (this.settings.constituencies.tooltipProperties.value ?? "").split(",").map(k => k.trim()).filter(Boolean)) {
            const value = props[key];
            if (value !== undefined && value !== null && value !== "") items.push({ displayName: key, value: String(value) });
        }
        const stationCount = this.visibleStations.filter(s => s.constituency === props.__name).length;
        if (this.data.constituencyTarget && stationCount > 0) items.push({ displayName: "Stations shown", value: String(stationCount) });
        return items;
    }

    private hideTooltip(): void {
        if (this.hoverKey === null) return;
        this.hoverKey = null;
        this.host.tooltipService.hide({ isTouchEvent: false, immediately: true });
    }

    private onClick(e: MapMouseEvent): void {
        if (!this.host.hostCapabilities.allowInteractions) return;
        const { station, constituency } = this.hit(e);
        const original = e.originalEvent;
        if (station) {
            const multi = original.ctrlKey || original.metaKey || original.shiftKey;
            this.selectionManager.select(station.selectionId, multi).then(() => this.render());
            return;
        }
        this.selectionManager.clear().then(() => this.render());
        if (constituency) {
            this.toggleConstituency(String(constituency.properties.__name ?? ""));
        } else if (this.selectedConstituency) {
            this.applyConstituencyFilter(null);
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
        this.applyConstituencyFilter(name === this.selectedConstituency ? null : name);
    }

    private applyConstituencyFilter(name: string | null): void {
        const target = this.data.constituencyTarget;
        if (!target || name === null) {
            this.host.applyJsonFilter(null, "general", "filter", FilterAction.remove);
            return;
        }
        const filter: IBasicFilter = {
            // eslint-disable-next-line powerbi-visuals/no-http-string -- fixed schema id defined by powerbi-models, not a URL that is fetched
            $schema: "http://powerbi.com/product/schema#basic",
            target,
            operator: "In",
            values: [name],
            filterType: 1 // models.FilterType.Basic
        };
        this.host.applyJsonFilter(filter, "general", "filter", FilterAction.merge);
    }

    private readConstituencyFilter(filters: IBasicFilter[] | undefined): string | null {
        const target = this.data.constituencyTarget;
        const filter = filters?.find(f => {
            const t = f?.target as IFilterColumnTarget | undefined;
            return t && target && t.table === target.table && t.column === target.column;
        }) ?? filters?.[0];
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
