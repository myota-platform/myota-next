# HTTP compatibility

NestJS HTTP APIs format framework and parser failures with the shared `Problem`
schema in the OpenAPI contract. Responses carry request and correlation IDs in
headers and in the problem body. `X-Trace-ID` follows the request ID used by
Nest observability, and API responses include `API-Version: v1`. Geodata JSON
responses with an integer `version` also include the reference's quoted
version `ETag`. Identity login preserves the reference status
behavior: invalid credentials return 400, while permission and rate-limit
failures return 403. Other NestJS 401 permission exceptions also map to 403.
Identity, Programmes, Activity, and Geodata APIs send the reference CORS headers
on responses and answer preflight requests; Geodata also allows `If-Match`.
Their 204 responses retain the reference JSON content type and zero content
length.
Malformed JSON and oversized JSON bodies use the reference's 400
`invalid_request` response shape and details.
The shared parser decodes JSON request bodies regardless of `Content-Type` or
declared charset, as the reference does. It applies the same invalid request
details to malformed JSON, invalid UTF-8, a leading UTF-8 BOM, and compressed
request bodies, which the reference attempts to decode as plain UTF-8 JSON.
Routes whose validation or string conversion depends on Python numeric values
retain arbitrary-precision integer tokens and direct float-token metadata
before the request reaches its service handler.
The Geodata import creation route retains its dedicated multipart
handling for `multipart/form-data`, and Activity award image uploads retain
their route-specific binary handling.
Requests with no body reach handlers as an empty object, matching the Python
request parser's zero-length body behavior. Non-object JSON values are rejected
with `JSON body must be an object`, matching the reference parser.
The Gateway forwards W3C `traceparent` and `tracestate` headers to the owning
API, permits them in browser preflight requests, and passes trace headers back
to clients when an upstream provides them.
It bypasses request-body parsing, streams incoming bodies to the owning API,
and preserves the declared `Content-Length` for binary and JSON payloads.
When it forwards an already parsed JSON body, its serializer preserves exact
large integer tokens instead of rounding them or failing on `BigInt` values.
Paged endpoints accept arbitrary-size Python integer page values and preserve
those exact integers in JSON responses, including values above JavaScript's
safe integer range. Database page totals also avoid PostgreSQL 32-bit casts and
JavaScript number rounding, preserving exact integer totals in JSON. SQL page
offsets remain exact beyond JavaScript's safe integer range and reach the
database as integer parameters. Programme content coverage keeps total and
published key counts exact as well.

The route maps at the pinned Python reference revision contain 135 literal
method/path pairs across Identity, Programmes, Activity, Awards, and Geodata.
A source comparison against the Nest controller decorators found all 135 pairs
present. The Nest implementation also exposes seven route pairs without a
matching reference route: `GET /v1/_internal/grafana/auth`, `GET /v1/metrics`,
`GET /v1/public/programmes/{slug}/content`,
`POST /v1/activity/work-jobs/{jobId}/redrive`, `POST /v1/adif/imports`,
`POST /v1/geodata/imports/{runId}/processing-queues/{queueId}/redrive`, and
`POST /v1/qso-ingestions/csv`. These additions are not evidence of legacy
parity. Route presence alone does not establish payload, authorization,
persistence, error, or workflow parity.
