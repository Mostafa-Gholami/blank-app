"use strict";

import type { Feature, FeatureCollection, Geometry, LineString, MultiLineString, MultiPolygon, Point, Polygon, Position } from "geojson";
import polylabel from "polylabel";

export type Bounds = [number, number, number, number]; // [west, south, east, north]

export interface ReferenceLayers {
    polygons: FeatureCollection<Polygon | MultiPolygon>;
    labels: FeatureCollection<Point>;
    lines: FeatureCollection<LineString | MultiLineString>;
    bounds: Bounds | null;
    /** Constituency name -> polygon bounds, for zoom-to-constituency. */
    boundsByName: Map<string, Bounds>;
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColour(value: unknown): value is string {
    return typeof value === "string" && HEX.test(value.trim());
}

/**
 * Splits combined_layers.geojson into polygon, label-point and line collections.
 * Adds normalised `__name`, `__fill`, `__stroke` (polygons) and `__class` (lines) properties
 * so the map layers never depend on the raw property names.
 */
export function buildReferenceLayers(source: FeatureCollection, nameProperty: string): ReferenceLayers {
    const polygons: Feature<Polygon | MultiPolygon>[] = [];
    const labels: Feature<Point>[] = [];
    const lines: Feature<LineString | MultiLineString>[] = [];
    const boundsByName = new Map<string, Bounds>();
    let bounds: Bounds | null = null;

    for (const feature of source?.features ?? []) {
        const geometry = feature?.geometry;
        if (!geometry) continue;
        const props = feature.properties ?? {};

        if (geometry.type === "Polygon" || geometry.type === "MultiPolygon") {
            const name = String(props[nameProperty] ?? props.name ?? "");
            const featureBounds = geometryBounds(geometry);
            polygons.push({
                type: "Feature",
                geometry,
                properties: {
                    ...props,
                    __name: name,
                    __fill: isHexColour(props.fill) ? props.fill : null,
                    __stroke: isHexColour(props.stroke) ? props.stroke : (isHexColour(props.fill) ? props.fill : null)
                }
            });
            if (name) {
                labels.push({ type: "Feature", geometry: { type: "Point", coordinates: labelPoint(geometry) }, properties: { __name: name } });
                if (featureBounds) boundsByName.set(name, featureBounds);
            }
            bounds = unionBounds(bounds, featureBounds);
        } else if (geometry.type === "LineString" || geometry.type === "MultiLineString") {
            lines.push({ type: "Feature", geometry, properties: { ...props, __class: classifyLine(props) } });
            bounds = unionBounds(bounds, geometryBounds(geometry));
        }
    }

    return {
        polygons: { type: "FeatureCollection", features: polygons },
        labels: { type: "FeatureCollection", features: labels },
        lines: { type: "FeatureCollection", features: lines },
        bounds,
        boundsByName
    };
}

/**
 * Decides whether a line is a mainline or a branch. Looks for an explicit type-like property first,
 * then falls back to the simplestyle `stroke-width` baked into combined_layers.geojson (mainlines 3px, branches 1.4px).
 */
export function classifyLine(props: Record<string, unknown>): "mainline" | "branch" {
    for (const key of ["line_class", "line_type", "class", "type", "category", "layer", "kind", "Mainline", "mainline"]) {
        const value = props[key];
        if (typeof value === "boolean") return value ? "mainline" : "branch";
        if (typeof value === "string") {
            if (/branch|non[-_ ]?main|secondary/i.test(value)) return "branch";
            if (/main/i.test(value) || /^(y|yes|true)$/i.test(value)) return "mainline";
        }
    }
    const width = Number(props["stroke-width"]);
    if (Number.isFinite(width)) return width >= 2 ? "mainline" : "branch";
    return "mainline";
}

function labelPoint(geometry: Polygon | MultiPolygon): Position {
    const rings = geometry.type === "Polygon" ? geometry.coordinates : largestPolygon(geometry.coordinates);
    const [x, y] = polylabel(rings, 0.001);
    return [x, y];
}

function largestPolygon(polygons: Position[][][]): Position[][] {
    let best = polygons[0];
    let bestArea = -1;
    for (const polygon of polygons) {
        const area = Math.abs(ringArea(polygon[0] ?? []));
        if (area > bestArea) {
            best = polygon;
            bestArea = area;
        }
    }
    return best;
}

function ringArea(ring: Position[]): number {
    let sum = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
    }
    return sum / 2;
}

export function geometryBounds(geometry: Geometry): Bounds | null {
    let bounds: Bounds | null = null;
    const visit = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0] === "number") {
            const [x, y] = coords as number[];
            bounds = extend(bounds, x, y);
            return;
        }
        for (const c of coords) visit(c);
    };
    if (geometry.type === "GeometryCollection") {
        for (const g of geometry.geometries) bounds = unionBounds(bounds, geometryBounds(g));
    } else {
        visit(geometry.coordinates);
    }
    return bounds;
}

export function extend(bounds: Bounds | null, x: number, y: number): Bounds {
    if (!bounds) return [x, y, x, y];
    return [Math.min(bounds[0], x), Math.min(bounds[1], y), Math.max(bounds[2], x), Math.max(bounds[3], y)];
}

export function unionBounds(a: Bounds | null, b: Bounds | null): Bounds | null {
    if (!a) return b;
    if (!b) return a;
    return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

const EARTH_RADIUS_MILES = 3958.8;

/** Geodesic circle (as a polygon) around a point; matches the haversine distance used by In_Radius. */
export function circlePolygon(lat: number, lon: number, miles: number, steps = 96): Feature<Polygon> {
    const angular = miles / EARTH_RADIUS_MILES;
    const phi1 = toRad(lat);
    const lambda1 = toRad(lon);
    const ring: Position[] = [];
    for (let i = 0; i <= steps; i++) {
        const bearing = (2 * Math.PI * i) / steps;
        const phi2 = Math.asin(Math.sin(phi1) * Math.cos(angular) + Math.cos(phi1) * Math.sin(angular) * Math.cos(bearing));
        const lambda2 = lambda1 + Math.atan2(Math.sin(bearing) * Math.sin(angular) * Math.cos(phi1), Math.cos(angular) - Math.sin(phi1) * Math.sin(phi2));
        ring.push([toDeg(lambda2), toDeg(phi2)]);
    }
    return { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} };
}

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
