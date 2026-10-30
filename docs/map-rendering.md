# Map rendering strategy

Maps render simplified display geometry at the current zoom while keeping the
canonical geometry in Geodata unchanged. The UI must send edits from the
canonical entity data, never from simplified map features.

## Geometry detail

The Geodata service converts display geometry to Web Mercator, applies
`ST_SimplifyPreserveTopology`, and transforms the result back to WGS 84. Its
tolerance is shared by participant vector tiles and Admin map responses:

```text
max(0.05 metres, 156543.03392804097 / 2^zoom * 0.65)
```

Lower zooms therefore remove more vertex detail. Points and other non-linear,
non-polygonal geometry keep their shape. The Admin map component caches the two
most recently used zoom levels and falls back to canonical display geometry if
the simplification request fails. Geometry being edited is always drawn from
the canonical entity response.

The Admin entity map requests only entities intersecting its current viewport.
The service clips returned geometries to that viewport, orders dense results
near the viewport centre, and returns at most 500 entities. It reports the
full match count and whether more than 500 were available. The UI also invites
users to zoom in when exactly 500 entities match. A changed viewport triggers
a new request.

Other Admin maps submit display geometries to `POST /v1/geodata/map/simplify`
in batches of at most 500 items and 3 MiB of serialized request data. The API
accepts up to 500 geometries and at most 4 MiB per request. These limits bound
per-request work and payload size; the client splits larger map sets into
multiple requests.

## Response compression

Traefik negotiates Brotli (`br`) when supported and gzip as a fallback. The
compression middleware is attached to the API hostname, the Admin hostname,
and the participant API route. It preserves `Vary: Accept-Encoding`, allowing
intermediaries to distinguish compressed and uncompressed responses. The
deployment verification script checks equivalent decoded tile data and
reduced transfer size through both the public API and Admin hostnames.
