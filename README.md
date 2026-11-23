# PDfEr — templated document engine

Template + JSON in, PDF out. One container, no configuration, no database.

**Documentation:** [`docs/`](docs/README.md) — from a five-minute introduction to
determinism and provenance.

```bash
docker run -d -p 8080:8080 -v pdfer:/data nyingi/pdfer:1.1.0
```

That is the whole setup. On first boot the container seeds a `demo` tenant with an
invoice schema, a published template, a footer, and a font bundle — then renders a
self-test page to prove the renderer works.

```bash
curl -s -X POST http://localhost:8080/render \
  -H 'content-type: application/json' \
  -d '{
    "tenant": "demo",
    "documentType": "invoice",
    "mode": "production",
    "template": "default",
    "generatedAt": "2026-01-31T09:00:00Z",
    "options": { "footerTemplateRef": "default" },
    "data": {
      "invoiceNumber": "INV-0000",
      "issuedOn": "2026-01-31",
      "customerName": "EXAMPLE CUSTOMER",
      "items": [
        { "description": "EXAMPLE ITEM", "quantity": 2, "unitPrice": 500, "lineTotal": 1000 }
      ],
      "total": 1000
    }
  }' --output invoice.pdf
```

Open <http://localhost:8080/> for a landing page with the same example.

---

## What runs in the container

| Process | Role | Exposure |
|---|---|---|
| `node src/server.js` | Engine, HTTP API, storage | `:8080` (the only published port) |
| `gotenberg` (supervised child) | Chromium HTML → PDF | `127.0.0.1:3001`, never published |

The renderer is started by the engine with:

- `--chromium-disable-javascript` — templates cannot execute script;
- `--chromium-deny-private-ips --chromium-deny-public-ips` — no egress, in either direction;
- `--api-disable-download-from --webhook-disable` — those routes are off;
- `--libreoffice-disable-routes --pdfengines-disable-routes` — unused engines are off;
- lazy Chromium start and a 180 s idle shutdown, so an idle container stays small.

If the renderer dies it is restarted with bounded backoff; renders fail with
`RENDERER_UNAVAILABLE` in the meantime and `/readyz` reports `503`.

2 MiB of template, 32 MiB of data, 64 MiB of assets, 100 MiB of output.
Nothing is written outside `/data`.

Measured on the reference build (2 vCPU): 1.86 GB image, ~50-60 MB idle RSS (Chromium sleeps after 3 min),
9.0 s for a 10 000-row / 201-page render at 426 MB peak.

---

## Zero configuration

| Volume | Contents |
|---|---|
| `/data` | templates, template state, assets, generated artifacts |

Nothing else is required: no database, no object store, no message broker, no TLS
termination, no configuration file. Every knob below has a default.

| Env | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `PDFER_DATA_DIR` | `/data` | the only volume |
| `PDFER_SCHEMAS_FILE` | — | manifest declaring your document types ([Schemas](docs/05-schemas.md)) |
| `PDFER_AUTH_MODE` | `off` | `off` or `apikey` |
| `PDFER_API_KEY` | — | required when `apikey` |
| `PDFER_MAX_CONCURRENCY` | `2` | parallel Chromium conversions |
| `PDFER_MAX_QUEUE` | `32` | waiting renders before `RENDER_QUEUE_FULL` |
| `PDFER_RENDER_TIMEOUT_MS` | `60000` | |
| `PDFER_RENDER_RETRIES` | `2` | infrastructure errors only |
| `PDFER_MAX_BODY_BYTES` | `34603008` | 33 MiB |
| `PDFER_MAX_TEMPLATE_BYTES` | `2097152` | 2 MiB |
| `PDFER_MAX_DATA_BYTES` | `33554432` | 32 MiB |
| `PDFER_MAX_ASSET_BYTES` | `10485760` | 10 MiB |
| `PDFER_MAX_BUNDLE_BYTES` | `67108864` | 64 MiB |
| `PDFER_MAX_ROWS` | `50000` | per render, all collections |
| `PDFER_SEED_DEMO` | `true` | only when `/data` has no templates |
| `PDFER_ARTIFACT_RETENTION_DAYS` | `0` | `0` keeps artifacts forever; `30` is a sane production default |
| `PDFER_RATE_LIMIT_PER_MINUTE` | `0` | fixed window per client IP; `0` disables |
| `PDFER_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |

Backups are `tar` of `/data`. There is no migration step.

> **Bind mounts.** The container runs as uid `1001`. A named volume inherits the
> right ownership automatically; a host directory must be writable by that uid
> (`sudo chown -R 1001:1001 ./data`) or the engine cannot write its first boot
> self-test artifact.

---

## HTTP surface

Every route exists both unprefixed (`/render`) and versioned (`/v1/render`).
The contract is [`schema/openapi.yaml`](schema/openapi.yaml).

| Method | Path | Purpose |
|---|---|---|
| GET | `/document-types?tenant=` | available document types |
| GET | `/document-types/{key}/placeholders?version=` | field palette (incl. reserved tokens) |
| GET | `/document-types/{key}/sample-data` | sample payload that validates |
| GET | `/templates?tenant=&documentType=&state=&limit=&cursor=` | paginated metadata |
| GET | `/templates/{id}?tenant=&version=` | one version, with content |
| POST | `/templates` | save a new version (`draft`) |
| POST | `/templates/{id}/versions/{v}/publish` | publish (immutable afterwards) |
| POST | `/templates/{id}/versions/{v}/default` | make it the tenant default |
| POST | `/templates/{id}/versions/{v}/retire` | retire (content kept) |
| POST | `/validate` | always `200` with a report |
| POST | `/compile` | HTML only, no renderer |
| POST | `/preview` | preview with sample data, no writes |
| POST | `/render` | produce a PDF |
| GET | `/artifacts/{handle}?tenant=` | download a stored artifact |
| GET | `/jobs/{id}?tenant=` | async render status |
| PUT | `/assets/{path}?tenant=` | register a font/image (raw body) |
| GET | `/assets?tenant=` | list asset metadata |
| GET | `/healthz` · `/readyz` · `/version` · `/metrics` | operations |

Provenance headers on every render: `X-Template-Id`, `X-Template-Version`,
`X-Schema-Version`, `X-Renderer-Image`, `X-Input-Hash`, `X-Page-Count`,
`X-Artifact-Handle`.

**Async renders.** Send `Prefer: respond-async` (or `?async=true`) for documents
that will take longer than your gateway allows. You get `202` +
`Location: /v1/jobs/{id}`; poll until `303`, then fetch the artifact.

```bash
curl -s -X POST 'localhost:8080/render?async=true' -H 'content-type: application/json' -d @req.json
# {"jobId":"job_…","status":"running"}
```

---

## Templates

Templates are HTML + [Liquid](https://liquidjs.com). They are **plain text**,
versioned, and immutable once published. Editing creates `n+1` as a draft.

```
save ──► draft ──publish──► published ──retire──► retired
          │                   │
          └── save (n+1) ─────┘
```

- `template: "default"` resolves the tenant default. There is **no cross-tenant
  or global fallback**: a tenant with no published default gets
  `NO_DEFAULT_TEMPLATE`.
- Saving with `baseVersion` (or `If-Match: "<checksum>"`) turns a concurrent edit
  into `VERSION_CONFLICT` instead of a lost update.
- Header and footer templates live in synthetic document types
  (`invoice-footer`, `invoice-header`) and are referenced with
  `"footerTemplateRef": "default"`.

### Supported Liquid subset

Tags: `for`, `if`/`elsif`/`else`, `unless`, `assign`, `raw`, `comment`.
Filters: `escape`, `escape_once`, `default`, `upcase`, `downcase`, `capitalize`,
`strip`, `strip_newlines`, `newline_to_br`, `join`, `size`, `first`, `last`,
`truncate`, `append`, `prepend`, `replace`.

Everything else is rejected with a line and column: `include`, `render`,
`capture`, `case`, `cycle`, `date`, `plus`/`minus`/`times`, and any host-language
expression. Whitespace control (`{{- -}}`, `{%- -%}`) is supported.

**Values are escaped for you.** The binder HTML-escapes every `string` before it
reaches the template, so do not add `| escape` to a placeholder — it would
double-escape. A schema field declared `dataType: "html"` is the explicit
opt-out and is the caller's responsibility.

**Templates do not compute.** No totals, no sorting, no date maths, no currency
conversion. The caller sends already-computed, already-typed values. Dates and
money are formatted by the binder from `formatHint`, in UTC, with no locale:

| Data type | Input | `formatHint` | Output |
|---|---|---|---|
| `money` | number `1250` | `#,##0.00` | `1,250.00` |
| `money` | number `1250` | `€ #,##0.00` | `€ 1,250.00` |
| `date` | `2026-03-14` | `yyyy-MM-dd` | `2026-03-14` |
| `datetime` | `2026-03-14T08:00:00Z` | `yyyy-MM-dd HH:mm` | `2026-03-14 08:00` |

Pre-formatted input (`"1,250.00"`) is `TYPE_MISMATCH`, not silently accepted.

---

## Assets

Fonts and images travel as **files**, never data URIs or remote URLs.

```bash
curl -X PUT 'localhost:8080/assets/assets/logo.png?tenant=acme' \
  -H 'content-type: image/png' --data-binary @logo.png
```

Then reference `./assets/logo.png` in the template. If the request omits
`assets`, the engine bundles every referenced path from the tenant's store; if
it includes `assets`, that list is authoritative and any referenced-but-missing
path fails with `ASSET_MISSING`. Assets are tenant-scoped: one tenant cannot
resolve another tenant's `assetRef`.

Absolute paths, `..`, `http(s)://`, `file://` and (by default) `data:` URIs are
rejected at validation with a location.

---

## Errors

Stable codes are the contract; messages are not. Envelope:

```json
{ "error": { "code": "UNKNOWN_TOKEN", "message": "…", "location": { "line": 4, "column": 12 },
             "details": { "suggestion": "issuedOn", "requestId": "req_…" },
             "retriable": false } }
```

`422` unparseable body · `400` semantic rejection · `401` auth · `404` not found ·
`409` state conflict · `413` too large · `503`/`504` renderer unavailable/timeout ·
`500` internal. Retry only what says `"retriable": true`, with backoff.

Validation is a normal response: `POST /validate` returns `200` with
`isRenderable: false` and the list of problems. Send it while the user types.

---

## Development

```bash
npm install
npm test                       # 71 unit/integration tests, no container needed
```

Running the service locally needs a renderer. Either use the container:

```bash
docker compose up -d --build
```

or point the engine at an existing Gotenberg:

```bash
GOTENBERG_URL=http://localhost:3000 PDFER_DATA_DIR=./.pdfer-data npm start
```

`npm test` uses a deterministic fake renderer; `test/http.test.js` exercises the
real HTTP surface with `fastify.inject`. Build and smoke tests run in WSL:

```bash
wsl -e bash /mnt/d/work/nyingi/code/systems/Pdfer/scripts/verify.sh
```

`scripts/verify.sh` builds the image, boots it on a throwaway volume, and runs:

| Script | Checks |
|---|---|
| `scripts/smoke.sh` | 28 checks: readiness, catalogue, validation diagnostics, render + provenance, preview purity, lifecycle, tenancy, async, error envelope, metrics |
| `scripts/renderer-supervision-test.sh` | kill the renderer: liveness stays up, readiness goes `503`, child restarts |
| `scripts/perf-check.js` | 1 000 and 10 000 row renders (run inside the container with `docker cp`) |
| `scripts/pdf-assert.js` | page count, extractable text, footer numbering (needs `devDependencies`) |
| `scripts/render-sample.js` | writes a demo PDF for inspection |

```bash
node conformance/run.js     # 36 dialect fixtures (the editor/server contract)
```

> Docker here runs inside WSL. The distro shuts down shortly after the last
> shell exits, which stops running containers — start the container and run the
> test in the same `wsl` invocation, as the scripts do. Docker Desktop removes
> that constraint.

---

## Why it looks like this

- **One container.** A second container is a second thing to pin, version, and
  keep healthy. The renderer is a child process on loopback, supervised by the
  engine, and its version is recorded in every artifact's provenance.
- **Filesystem storage.** Templates are small text files with atomic renames;
  artifacts are files. No database engine means no migration, no connection
  pool, no idle RAM. Postgres/S3 adapters remain available behind the same ports
  for multi-instance deployments.
- **Content-addressed provenance.** `inputHash` covers compiled HTML + asset
  checksums + render options; `dataHash` covers the bound model. Re-rendering
  the same inputs reproduces the compiled HTML exactly.
- **Determinism over byte-identity.** PDF bytes contain timestamps from
  Chromium, so equality is defined as page count + extracted text, never a
  checksum. Do not write that test.

Deviations from the v1.0 BRS, with rationale, are listed in
[`SPEC-v1.1.md`](SPEC-v1.1.md) §9.
