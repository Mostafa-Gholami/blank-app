// Bundled GeoJSON is imported untyped: type-checking a multi-megabyte JSON literal would stall tsc.
declare module "*.json" {
    const value: unknown;
    export default value;
}

declare module "polylabel" {
    export default function polylabel(polygon: number[][][], precision?: number, debug?: boolean): number[] & { distance: number };
}
