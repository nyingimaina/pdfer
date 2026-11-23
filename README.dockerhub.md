# PDfEr — templated document engine

Turns a template + JSON into a PDF. One container: the engine and a pinned
Chromium renderer, no external services.

```bash
docker run -d --name pdfer \
  -p 8080:8080 \
  -v pdfer-data:/data \
  -e PDFER_AUTH_MODE=apikey \
  -e PDFER_API_KEY=change-me \
  nyingi/pdfer:1.1.0
```

```bash
curl -s -X POST http://localhost:8080/render \
  -H "Authorization: Bearer change-me" \
  -H 'content-type: application/json' \
  -d '{
    "tenant": "demo",
    "documentType": "invoice",
    "mode": "production",
    "template": "default",
    "generatedAt": "2026-01-31T09:00:00Z",
    "data": {
      "invoiceNumber": "INV-0000",
      "issuedOn": "2026-01-31",
      "customerName": "EXAMPLE CUSTOMER",
      "items": [{"description": "EXAMPLE ITEM", "quantity": 2, "unitPrice": 500, "lineTotal": 1000}],
      "total": 1000
    }
  }' --output invoice.pdf
```

## What it is

- **Templates are HTML + Liquid** (a deliberately small subset: `for`, `if`,
  `unless`, `assign`, `raw`, comments, and presentation-only filters).
- **Values are escaped and formatted by the engine**: dates and money come from
  the caller as numbers/ISO strings and are rendered with an explicit
  `formatHint`, in UTC, never with the host locale.
- **Compiling is pure**: same template + data + `generatedAt` gives byte-identical
  HTML. Preview writes nothing.
- **Templates are immutable versions**: editing creates a new version; publishing
  makes it live.
- **Every render has provenance**: template version, schema version, renderer
  version and an input hash.
- **Tenant-scoped**: templates, versions and assets are isolated per tenant.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PDFER_AUTH_MODE` | `off` | `off` or `apikey`. Use `apikey` whenever the port is reachable. |
| `PDFER_API_KEY` | — | Bearer token when `apikey` is on |
| `PDFER_DATA_DIR` | `/data` | Volume holding templates, assets and artifacts |
| `PDFER_ARTIFACT_RETENTION_DAYS` | `0` | Delete generated PDFs older than this (0 = keep) |
| `PDFER_RATE_LIMIT_PER_MINUTE` | `0` | Per-IP fixed window (0 = off) |
| `PDFER_SCHEMAS_FILE` | — | Read-only schema manifest merged at startup |
| `PDFER_SEED_DEMO` | `true` | Seeds a demo invoice on an empty volume |
| `PDFER_MAX_CONCURRENCY` | `2` | Parallel Chromium conversions |
| `PDFER_LOG_LEVEL` | `info` | |

Health and readiness: `GET /healthz` (process) and `GET /readyz` (renderer).
Metrics: `GET /metrics` (Prometheus).

## Endpoints

| Method | Path |
|---|---|
| GET | `/document-types?tenant=` |
| GET | `/document-types/{type}/placeholders` · `/sample-data` |
| GET/POST | `/templates` · `/templates/{id}` · `/templates/{id}/versions/{v}/{publish,default,retire}` |
| POST | `/validate` · `/compile` · `/preview` · `/render` |
| GET | `/artifacts/{handle}` · `/jobs/{id}` |
| GET/PUT/DELETE | `/assets` |

All routes also exist under `/v1`. The OpenAPI contract ships in the source
repository (`schema/openapi.yaml`).

## Security posture

- Templates cannot execute code; unsafe HTML (scripts, iframes, event handlers,
  remote URLs, data URIs) is rejected at validation with a line and column.
- Chromium runs with JavaScript disabled and both private and public IP deny
  rules, so a template cannot reach anything outside its asset bundle.
- Asset paths are confined to the tenant; `..`, absolute paths and URLs are
  rejected.
- The API key comparison is constant-time; responses are `no-store` + `nosniff`.
- The container runs as uid 1001 and supports a read-only root filesystem with a
  `/tmp` tmpfs.

## Sizing

~1.9 GB image. Roughly 50-60 MB idle (Chromium shuts down after three minutes without a render), ~260 MB warm and ~430 MB while rendering;
10 000 table rows render in about 9 seconds.

## Licence

MIT for the engine. The image bundles Gotenberg/Chromium/LibreOffice; see
`NOTICE` in the image and the Gotenberg image for their licences.
