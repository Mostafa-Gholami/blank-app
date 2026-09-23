"use strict";

import * as maplibreNamespace from "maplibre-gl";

/**
 * maplibre-gl ships a UMD bundle inside a `"type": "module"` package. Depending on how webpack
 * interprets it, the API is either the import namespace or a `maplibregl` global; accept both.
 */
const maplibregl: typeof maplibreNamespace =
    (maplibreNamespace as { Map?: unknown }).Map
        ? maplibreNamespace
        : (globalThis as unknown as { maplibregl: typeof maplibreNamespace }).maplibregl;

export default maplibregl;
