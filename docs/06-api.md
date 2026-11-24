# API

JSON in, PDF out. The normative contract is
[`schema/openapi.yaml`](../schema/openapi.yaml); this page is the working guide.

All routes exist twice: unprefixed (`/render`) and under `/v1` (`/v1/render`).

## Authentication

Two modes, chosen by `PDFER_AUTH_MODE`:

- `off` (default) — anything that can reach the port may call it. Fine for a
  loopback-only or private-network deployment.
- `apikey` — every route except `/healthz`, `/readyz`, `/version`, `/metrics`
  and `/` requires `Authorization: Bearer <PDFER_API_KEY>`.

There is no user model. The engine is designed to sit behind your backend, which
authenticates people and decides what they may do.

## Conventions

- `tenant` is always explicit: a query parameter on reads, a body field on writes.
- `generatedAt` is required on every compile/render and must be RFC 3339 UTC
  (`2026-03-14T08:00:00Z`). The engine never reads the clock.
- Unknown request fields are rejected, not ignored.
- Timestamps are UTC. Money is formatted by the engine, not by the caller.
- Errors are `{ "error": { code, message, location?, details?, retriable } }`.

## Reads

```http
GET /document-types?tenant=acme
GET /document-types/invoice/placeholders?version=4
GET /document-types/invoice/sample-data
GET /templates?tenant=acme&documentType=invoice&state=published&limit=100
GET /templates/{templateId}?tenant=acme&version=3
GET /artifacts/{handle}?tenant=acme
GET /jobs/{id}?tenant=acme
```

## Templates

```http
POST /templates
{
  "tenant": "acme",
  "documentType": "invoice",
  "syntaxId": "liquid",
  "content": "<!doctype html>…",
  "displayLabel": "Invoice — blue header",
  "baseVersion": 3            // optional: conflict instead of lost update
}
→ 200 { "templateId": "tpl_…", "version": 4, "checksum": "sha256:…" }

POST /templates/{id}/versions/4/publish?tenant=acme   → 204
POST /templates/{id}/versions/4/default?tenant=acme   → 204
POST /templates/{id}/versions/4/retire?tenant=acme    → 204
```

Saving with `sourceTemplateId` creates the next version of that template.
Without it, a new template is created. `baseVersion` (or `If-Match` with the
checksum) turns a concurrent edit into `409 VERSION_CONFLICT` instead of a
silent overwrite.

## Validation

```http
POST /validate
{
  "tenant": "acme",
  "documentType": "invoice",
  "inlineTemplate": { "syntaxId": "liquid", "content": "…" }
}
→ 200 {
  "isRenderable": false,
  "schemaVersion": 4,
  "syntaxErrors": [],
  "unknownTokens": [
    { "token": "invoiceDate", "location": { "line": 42, "column": 31 }, "suggestion": "issuedOn" }
  ],
  "unusedPlaceholders": [],
  "missingAssets": [],
  "schemaMismatches": [],
  "warnings": []
}
```

Always `200` for a well-formed request. A broken template is a normal answer,
not a protocol error. `422` is reserved for a body that could not be parsed.

## Compile and preview

```http
POST /compile    → text/html
POST /preview    → application/pdf (or text/html with "format": "html")
```

Both accept `inlineTemplate` or a stored `template`, and `data` or
`useSampleData: true`. `preview` writes nothing; `compile` additionally skips the
renderer entirely.

## Render

```http
POST /render
{
  "tenant": "acme",
  "documentType": "invoice",
  "mode": "production",
  "template": "default",              // or { "templateId": "tpl_…", "version": 3 }
  "generatedAt": "2026-03-14T08:00:00Z",
  "options": {
    "footerTemplateRef": "default",
    "metadata": { "title": "Invoice INV-0000" }
  },
  "data": { … }
}
→ 200 application/pdf
  X-Template-Id, X-Template-Version, X-Schema-Version,
  X-Renderer-Image, X-Input-Hash, X-Page-Count, X-Artifact-Handle
```

`mode: "preview"` behaves like preview: no artifact is stored. In production an
inline template is refused with `INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION`.

### Options

| Option | Default | Notes |
|---|---|---|
| `preferCssPageSize` | `true` | `@page` owns page size and margins |
| `paperWidth` / `paperHeight` | `210mm` / `297mm` | only when `preferCssPageSize` is false |
| `marginTop/Bottom/Left/Right` | `0` (mm) | explicit margins are honoured |
| `landscape` | `false` | |
| `printBackground` | `true` | |
| `scale` | `1.0` | 0.1–2.0 |
| `nativePageRanges` | all | e.g. `"1-3,5"` |
| `waitDelay` | none | e.g. `"500ms"` |
| `waitForExpression` | none | rejected: JavaScript is disabled |
| `failOnHttpStatusCodes` | `[499,500,501,502,503,504]` | |
| `headerTemplateRef` / `footerTemplateRef` | none | `"default"` or an explicit ref |
| `metadata` | `{}` | `title`, `author`, `subject`, `keywords` |

An option that cannot be honoured fails the request
(`RENDER_OPTION_UNSUPPORTED`); nothing is silently dropped.

## Long renders

```http
POST /render
Prefer: respond-async
→ 202 { "jobId": "job_…", "status": "running" }  + Location: /v1/jobs/job_…

GET /v1/jobs/job_…   → 202 while running, 303 + Location to the artifact when done
```

## Assets

```http
GET    /assets?tenant=acme
PUT    /assets/assets/logo.png?tenant=acme     (raw body, Content-Type required)
DELETE /assets/assets/logo.png?tenant=acme
```

Reference them from templates as `./assets/logo.png`. When a request omits
`assets`, the engine bundles every referenced path that exists in the tenant
store; when it supplies them, that list is authoritative.

A sub-resource that cannot be loaded fails the render with `502
RENDER_RESOURCE_FAILED` (not retriable) instead of yielding a PDF without it.
The response's `details.detail` carries the renderer's message, which names the
resource *type* (image, font) and the network error, not the path.

## Errors

| Status | Meaning |
|---|---|
| `400` | semantically invalid (unknown token, bad option, unsafe markup) |
| `401` | missing or wrong API key |
| `404` | unknown template, asset, artifact, job |
| `409` | state conflict (not published, immutable, version conflict) |
| `413` | a size limit was exceeded |
| `422` | the body could not be parsed |
| `429` | rate limited (only if enabled) |
| `502` | the renderer failed, or a resource in the template could not be loaded |
| `503` / `504` | renderer unavailable / timed out — retry with backoff |
| `500` | unexpected; never includes internals |

Every code is listed in [Troubleshooting](10-troubleshooting.md).
