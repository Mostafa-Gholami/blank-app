"use strict";

import powerbi from "powerbi-visuals-api";
import type { IFilterColumnTarget } from "powerbi-models";

import DataView = powerbi.DataView;
import DataViewMetadataColumn = powerbi.DataViewMetadataColumn;
import PrimitiveValue = powerbi.PrimitiveValue;
import ISelectionId = powerbi.visuals.ISelectionId;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import VisualTooltipDataItem = powerbi.extensibility.VisualTooltipDataItem;

export interface Station {
    key: string;
    name: string;
    lat: number;
    lon: number;
    facilityOwner: string | null;
    constituency: string | null;
    inRadius: boolean;
    /** null when nothing in the report is cross-highlighting this visual. */
    highlighted: boolean | null;
    selectionId: ISelectionId;
    tooltip: VisualTooltipDataItem[];
}

export interface RadiusSearch {
    lat: number;
    lon: number;
    miles: number;
}

export interface ParsedData {
    stations: Station[];
    hasInRadius: boolean;
    hasHighlights: boolean;
    radius: RadiusSearch | null;
    /** Column the constituency role is bound to; target for the polygon-click filter. */
    constituencyTarget: IFilterColumnTarget | null;
    invalidCoordinates: number;
}

interface RoleColumn {
    source: DataViewMetadataColumn;
    values: PrimitiveValue[];
    highlights?: PrimitiveValue[];
}

const EMPTY: ParsedData = { stations: [], hasInRadius: false, hasHighlights: false, radius: null, constituencyTarget: null, invalidCoordinates: 0 };

export function parseDataView(dataView: DataView | undefined, host: IVisualHost): ParsedData {
    const categorical = dataView?.categorical;
    const categories = categorical?.categories ?? [];
    const stationCategory = categories.find(c => c.source.roles?.station);
    if (!stationCategory) return EMPTY;

    const columns: RoleColumn[] = [
        ...categories.map(c => ({ source: c.source, values: c.values })),
        ...(categorical?.values ?? []).map(v => ({ source: v.source, values: v.values, highlights: v.highlights }))
    ];
    const byRole = (role: string) => columns.filter(c => c.source.roles?.[role]);
    const first = (role: string) => byRole(role)[0];

    const lat = first("latitude");
    const lon = first("longitude");
    if (!lat || !lon) return { ...EMPTY, constituencyTarget: columnTarget(first("constituency")?.source) };

    const owner = first("facilityOwner");
    const constituency = first("constituency");
    const inRadius = first("inRadius");
    const tooltipColumns = [owner, constituency, ...byRole("details"), ...byRole("tooltips")].filter(Boolean) as RoleColumn[];
    const highlightColumn = columns.find(c => c.highlights);

    const stations: Station[] = [];
    let invalidCoordinates = 0;

    for (let i = 0; i < stationCategory.values.length; i++) {
        const latitude = toNumber(lat.values[i]);
        const longitude = toNumber(lon.values[i]);
        if (!isValidCoordinate(latitude, longitude)) {
            invalidCoordinates++;
            continue;
        }
        const name = formatValue(stationCategory.values[i], stationCategory.source);
        const tooltip: VisualTooltipDataItem[] = [{ displayName: stationCategory.source.displayName, value: name }];
        for (const col of tooltipColumns) {
            const value = col.values[i];
            if (value === null || value === undefined || value === "") continue;
            tooltip.push({ displayName: col.source.displayName, value: formatValue(value, col.source) });
        }
        stations.push({
            key: `${name}|${latitude.toFixed(5)}|${longitude.toFixed(5)}`,
            name,
            lat: latitude,
            lon: longitude,
            facilityOwner: owner ? nullableText(owner.values[i]) : null,
            constituency: constituency ? nullableText(constituency.values[i]) : null,
            inRadius: inRadius ? isTruthy(inRadius.values[i]) : true,
            highlighted: highlightColumn ? highlightColumn.highlights[i] !== null && highlightColumn.highlights[i] !== undefined : null,
            selectionId: host.createSelectionIdBuilder().withCategory(stationCategory, i).createSelectionId(),
            tooltip
        });
    }

    return {
        stations,
        hasInRadius: !!inRadius,
        hasHighlights: !!highlightColumn,
        radius: readRadius(first("radiusLat"), first("radiusLon"), first("radiusMiles")),
        constituencyTarget: columnTarget(constituency?.source),
        invalidCoordinates
    };
}

/** Sel_Lat / Sel_Lon / Radius_mi evaluate the same on every row; take the first non-blank value. */
function readRadius(lat?: RoleColumn, lon?: RoleColumn, miles?: RoleColumn): RadiusSearch | null {
    if (!lat || !lon || !miles) return null;
    const pick = (col: RoleColumn) => {
        for (const v of col.values) {
            const n = toNumber(v);
            if (Number.isFinite(n)) return n;
        }
        return NaN;
    };
    const result = { lat: pick(lat), lon: pick(lon), miles: pick(miles) };
    return isValidCoordinate(result.lat, result.lon) && result.miles > 0 ? result : null;
}

/** Derives { table, column } for a BasicFilter from a bound grouping column. */
export function columnTarget(source: DataViewMetadataColumn | undefined): IFilterColumnTarget | null {
    if (!source) return null;
    const expr = source.expr as { source?: { entity?: string }; ref?: string } | undefined;
    if (expr?.source?.entity && expr.ref) return { table: expr.source.entity, column: expr.ref };
    const query = source.queryName ?? "";
    const dot = query.indexOf(".");
    return dot > 0 ? { table: query.substring(0, dot), column: query.substring(dot + 1) } : null;
}

function isValidCoordinate(lat: number, lon: number): boolean {
    return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
}

function toNumber(value: PrimitiveValue): number {
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "") return Number(value);
    return NaN;
}

function isTruthy(value: PrimitiveValue): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0 && Number.isFinite(value);
    if (typeof value === "string") return /^(1|true|yes|y)$/i.test(value.trim());
    return false;
}

function nullableText(value: PrimitiveValue): string | null {
    return value === null || value === undefined || value === "" ? null : String(value);
}

function formatValue(value: PrimitiveValue, source: DataViewMetadataColumn): string {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toLocaleDateString("en-GB");
    if (typeof value === "number") {
        if (source.format?.includes("%")) return `${(value * 100).toLocaleString("en-GB", { maximumFractionDigits: 1 })}%`;
        return value.toLocaleString("en-GB", { maximumFractionDigits: 2 });
    }
    return String(value);
}
