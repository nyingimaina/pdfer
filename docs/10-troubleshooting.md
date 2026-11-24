# Troubleshooting

## Start here

```bash
curl -s localhost:8080/readyz      # renderer + storage
docker logs pdfer --tail 50        # the last thing that went wrong
curl -s localhost:8080/version     # engine, API, renderer versions
```

`/readyz` returning `503` while `/healthz` is `200` means the engine is fine and
the renderer is not: check the container's stderr and memory.

## Error codes

| Code | Status | Typical cause | Fix |
|---|---|---|---|
| `REQUEST_INVALID` | 400 | unknown field, bad enum, missing `generatedAt`, both `template` and `inlineTemplate` | read the `details.field`; the request is strict on purpose |
| `REQUEST_TOO_LARGE` | 413 | body over `PDFER_MAX_BODY_BYTES` | raise the limit or send less |
| `DATA_TOO_LARGE` | 413 | `data` over 32 MiB | paginate the document instead |
| `TEMPLATE_TOO_LARGE` | 413 | template over 2 MiB | split the document |
| `TEMPLATE_NOT_FOUND` | 404 | wrong id, wrong tenant, or never saved | check tenant and version |
| `TEMPLATE_NOT_PUBLISHED` | 409 | production render of a draft/retired version | publish it, or set a default |
| `TEMPLATE_IMMUTABLE` | 409 | tried to modify a published version | save a new version instead |
| `TEMPLATE_RETIRED` | 409 | publish/setDefault on a retired version | create a new version |
| `NO_DEFAULT_TEMPLATE` | 404 | no published default for `(tenant, documentType)` | publish one and set it as default |
| `VERSION_CONFLICT` | 409 | `baseVersion`/`If-Match` mismatch | reload, merge, retry |
| `UNKNOWN_TOKEN` | 400 | placeholder not in the schema | use the `suggestion`; check the schema version |
| `TYPE_MISMATCH` | 400 | wrong JSON type, collection used outside a loop, pre-formatted money | send numbers for `money`/`number`, ISO strings for dates |
| `REQUIRED_PLACEHOLDER_MISSING` | 400 | a required placeholder was absent or null | supply it, or make it optional |
| `UNKNOWN_DATA_KEY` | 400 | `data` has a key the schema does not declare | remove it or declare it |
| `SCHEMA_VERSION_UNKNOWN` | 404 | document type or version not registered | check `PDFER_SCHEMAS_FILE` and its contents |
| `SCHEMA_VERSION_MISMATCH` | 400 | template authored against another schema version | render with its pinned version |
| `SCHEMA_INVALID` | 500 at startup | manifest violates the field rules | fix the manifest; the message names the path |
| `SCHEMA_REGISTRY_EMPTY` | 500 | no schemas registered | mount a manifest or enable the demo seed |
| `ASSET_MISSING` | 404 | template references a path with no file | upload it or fix the path |
| `ASSET_REJECTED` | 400 | `..`, absolute path, URL or bad name | use `./assets/<name>` |
| `ASSET_NOT_FOUND` | 404 | deleting/listing an unknown asset | check `GET /assets?tenant=` |
| `ASSET_TOO_LARGE` | 413 | asset or bundle over its limit | shrink or split |
| `PAGINATION_LIMIT_EXCEEDED` | 400 | too many collection rows | split the document |
| `TENANT_MISMATCH` | 409 | request tenant ≠ template tenant | use the template's tenant |
| `INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION` | 400 | production render with inline content | save and publish a version |
| `PREVIEW_SIDE_EFFECT_DENIED` | 400 | a mutating port call during preview | an integration bug; report it |
| `RENDER_OPTION_UNSUPPORTED` | 400 | option cannot be honoured (e.g. `waitForExpression` with JS disabled) | remove or change the option |
| `UNSAFE_MARKUP` | 400 | script/iframe/event handler/JS URL | remove it |
| `EXTERNAL_REFERENCE_REJECTED` | 400 | remote or absolute asset reference | add the asset to the bundle |
| `FILTER_NOT_ALLOWED` / `TAG_NOT_ALLOWED` | 400 | construct outside the supported subset | see [Templates](04-templates.md) |
| `RATE_LIMITED` | 429 | per-IP limit exceeded | retry with backoff |
| `RENDERER_UNAVAILABLE` | 503 | renderer down or not ready | check the container; retry |
| `RENDER_TIMEOUT` | 504 | exceeded `PDFER_RENDER_TIMEOUT_MS` | raise the timeout or reduce the document |
| `RENDER_FAILED` | 502 | renderer returned an error or a non-PDF | read the logged renderer message |
| `RENDER_RESOURCE_FAILED` | 502 | an image, font or stylesheet in the template could not be loaded | fix the reference; it is not retried |
| `RENDER_QUEUE_FULL` | 503 | concurrency + queue exhausted | retry, or raise limits |
| `OUTPUT_TOO_LARGE` | 500 | PDF over 100 MiB | split the document |
| `OUTPUT_WRITE_FAILED` | 500 | `/data` not writable or full | check the volume |
| `ARTIFACT_NOT_FOUND` | 404 | unknown handle or wrong tenant | handles are tenant-scoped |
| `JOB_NOT_FOUND` | 404 | unknown job, or the engine restarted | job state is in memory |
| `UNAUTHORIZED` | 401 | missing/wrong bearer token | check `PDFER_API_KEY` |
| `INTERNAL_ERROR` | 500 | unexpected | check logs; details are deliberately absent |

Diagnostics in `ValidationReport` use the same codes, plus a `location` with
line and column.

## Symptom-first

**“The button returns 502/503 and the log says 401 from the engine.”**
The caller's API key does not match `PDFER_API_KEY`. Environment variables are
read at startup; restart the caller. `docker inspect <engine> --format
'{{range .Config.Env}}{{println .}}{{end}}'` shows what the engine actually got.

**“I get 501 from the engine.”**
Something that is not the engine answered — usually a proxy or a port forwarder
in front of it, or the container is still starting. Check `docker port` and
`/readyz`.

**“First request for a tenant is slow.”**
Expected once: templates are provisioned from the caller's defaults on first
use.

**“Preview works, production says TEMPLATE_NOT_PUBLISHED.”**
Preview accepts drafts; production does not. Publish the version and, if you use
`"default"`, set it as the default.

**“Unknown token for a field I know exists.”**
The template is rendering against a pinned older schema version. Check
`GET /document-types/{type}/placeholders?version=…` and the template's recorded
`schemaVersion`.

**“A font is missing in the PDF.”**
The renderer image has a baseline (DejaVu, Liberation, Noto). Anything else must
be uploaded as an asset and declared with `@font-face url("./assets/…")`.
Validation reports the missing path.

**“PDFs differ between two renders.”**
Bytes contain Chromium metadata; that is expected. Compare page count and
extracted text instead. Compiled HTML *is* byte-identical.

**“Container exits at startup.”**
Read the first lines of the log: an invalid manifest, a renderer that never
became healthy, or `/data` not writable. All three are fail-fast by design.
