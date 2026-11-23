# PDfEr Engine — Specification v1.1

**Status:** Normative. Supersedes `templated-document-engine-BRS.md` v1.0 where they conflict.
**Audience:** Implementers and integrators.
**Base document:** `templated-document-engine-BRS.md` v1.0. All section references (§) and
requirement IDs in that document remain valid **unless amended here**.

This is a delta document, not a rewrite. It does four things:

1. fixes the conflicts in v1.0 that made the contract unimplementable as written;
2. pins the shippable artifact shape and the zero-configuration promise;
3. adds the requirements v1.0 was missing (escaping, encoding, lifecycle, async, health, assets);
4. shrinks the resource envelope to what a single container can actually honour.

---

## 1. Change register

| # | v1.0 position | v1.1 position | Reason |
|---|---|---|---|
| C1 | `pageNumber`/`totalPages` are Liquid tokens (§5.12) and Chromium classes (§8.5) | **Renderer classes only.** Not Liquid tokens | Two mechanisms cannot both be authoritative |
| C2 | `title` is header/footer-only (§5.12) but used in the main example (§8.5) | `title` is reserved in **all** scopes | The worked example is the reference behaviour |
| C3 | Schema version is not recorded on `Template`, not accepted by `RenderRequest`, yet I-8/T-16 require pinning | `Template.schemaVersion` (immutable) + optional `RenderRequest.schemaVersion` | I-8 and T-08 were unimplementable |
| C4 | R1 forbids filesystem I/O in compile; R10 permits `AssetResolver` | Compile **never** resolves assets. Asset existence is a `validate` concern | Purity is load-bearing; keep it strict |
| C5 | "Every endpoint is tenant-scoped" but four routes have no tenant | Schema catalogue is global; template/artifact routes are tenant-scoped | Removes the contradiction without inventing tenant-local schemas (E-2 stays deferred) |
| C6 | Global-default fallback (T3) | **Removed.** No cross-tenant fallback, ever | It contradicted T4, I-7 and `TENANT_MISMATCH` |
| C7 | 400 vs 422 for a malformed body | 422 = unparseable/structurally malformed; 400 = semantically invalid | H1 and H6 disagreed |
| C8 | "The engine never reads the wall clock" (I-9) but `Template.createdAt` exists | Clock is injected and may only be used by stores, never in compiled output or provenance | Keeps I-9 without banning timestamps |
| C9 | `@page { margin: 0 }` + `preferCssPageSize` + "engine sets header margins" | Template `@page` owns geometry; missing header/footer room is a **validation warning**, not silent fixing | T-12 asserted clipping as a feature |
| C10 | `formatHint: "0.00"` yields `"1,250.00"` | Numeric hints use .NET-style patterns; grouping requires `#,##0.00`. Money input is **numeric** | The examples were self-contradictory |
| C11 | `@import`/remote `url()` must pass through unmodified; no egress | Bundle-relative only; absolute/remote → `EXTERNAL_REFERENCE_REJECTED` | CSS transparency cannot outrank I-5 |
| C12 | P1 promises limit errors "from §13" that do not exist | Adds `REQUEST_TOO_LARGE`, `DATA_TOO_LARGE`, `OUTPUT_TOO_LARGE` | P1 referenced phantom codes |
| C13 | §5.1 omits save/publish/retire | Added as engine operations | §7 exposed endpoints with no contract behind them |

---

## 2. Deliverables and runtime contract

### 2.1 Artifacts

| ID | Artifact | Form | Notes |
|---|---|---|---|
| **D-1** | Engine service | **One OCI image**, `linux/amd64` + `linux/arm64`, port `8080` | The product |
| **D-2** | Renderer | Gotenberg binary + Chromium **inside D-1**, loopback only (`127.0.0.1:3001`) | Not a second container |
| **D-3** | Core library | `@pdfer/core` package, no native dependencies | Embeddable; used by tests |
| **D-4** | Contract | `schema/openapi.yaml` (OpenAPI 3.1) + JSON Schemas + error-code list | Normative; prose examples are illustrative |
| **D-5** | Conformance kit | `conformance/` fixtures + runner | Verifies any implementation |
| **D-6** | Deploy assets | `Dockerfile`, `docker-compose.yml`, health endpoints | Zero config |
| **D-7** | Demo tenant | Seeded `invoice` schema, template, footer, fonts | Proves the container works on first boot |

**D-8** — No artifact may require an external database, message broker, object store, cache,
or reverse proxy. The **only** external dependency is an optional data volume.

**D-9** — The engine and renderer MUST run in the same process tree, supervised, with the
renderer reachable only on loopback. A renderer crash MUST NOT take the engine down.

**D-10** — Startup MUST fail fast (exit ≠ 0) if the seeded self-test render fails.

### 2.2 Zero-configuration contract

| ID | Requirement |
|---|---|
| **Z-1** | `docker run -p 8080:8080 -v pdfer:/data pdfer/pdfer:1.1` MUST serve a working engine with a seeded `invoice` document type. No other flags required. |
| **Z-2** | Every setting has a documented default. No configuration file is read. |
| **Z-3** | `/data` is the only required volume: templates, assets, artifacts, and state live there and nothing else does. |
| **Z-4** | Authentication is **off** by default (`PDFER_AUTH_MODE=off`) and MUST be enabled explicitly. |
| **Z-5** | Exactly one port is exposed. The renderer port is never published. |
| **Z-6** | First boot seeds the demo tenant **only if `/data` is empty**. Seeding never overwrites user data. |
| **Z-7** | The container MUST be healthy (`/readyz`) within 30 s of start on a 2 GB / 2 vCPU host. |
| **Z-8** | `SIGTERM`: stop accepting, drain in-flight renders (≤ 20 s), terminate the renderer, exit 0. |
| **Z-9** | Data survives container replacement through `/data`. No migration step is required by the user. |
| **Z-10** | No user-facing configuration may reference Gotenberg flags, Chromium paths, or PDF internals. |

---

## 3. Normative resolutions

### 3.1 Page numbering (replaces §5.12 rows for `pageNumber`/`totalPages`)

`pageNumber`, `totalPages`, `title`, `url`, `date` are **reserved HTML class names** inside the
header/footer documents, substituted by Chromium. They are **not** Liquid tokens and MUST NOT
appear in a placeholder schema.

- Header/footer documents MUST be complete HTML documents (Gotenberg requirement), not fragments.
- Reservations in the Liquid model are therefore exactly: **`generatedAt`** (formatted
  `yyyy-MM-dd HH:mm` UTC), **`documentType`**, **`title`**
  (`options.metadata.title`, else `documentType`). All three are readable in main, header and
  footer scopes.
- `HARDCODED_PAGE_NUMBER` (warning) fires when the **main** template contains
  `class="pageNumber"`, `class="totalPages"`, `counter(page`, or `counter(pages`.

### 3.2 Schema pinning (amends §5.5, §5.6, I-8, T-08, T-16)

- `Template.schemaVersion` is **required** and **immutable**, captured at save time from the
  registry's latest version for that document type.
- `RenderRequest.schemaVersion` is optional. Resolution: explicit value → `Template.schemaVersion`.
- An explicit version that does not exist is `SCHEMA_VERSION_UNKNOWN`.
- `validate` with an explicit `schemaVersion` different from the schema the template was authored
  against returns `SCHEMA_VERSION_MISMATCH` and MUST NOT reinterpret tokens.
- Reproducing a document therefore pins `(templateId, templateVersion, schemaVersion)`.

### 3.3 Purity boundary (amends R1, R10, §3.3)

- `compile` performs **no I/O at all**. It receives template text and a bound model.
- `validate` MAY use `AssetResolver` (existence and size only) and MUST report `missingAssets`.
- `render` resolves assets **after** compilation, immediately before the renderer call.
- `AssetResolver` is not a compile dependency. R10's parenthetical is amended accordingly.

### 3.4 Tenant scoping (amends H4, S-4, §7)

Global (no tenant parameter): `GET /document-types`, `GET /document-types/{key}/placeholders`,
`GET /document-types/{key}/sample-data`, `GET /healthz`, `GET /readyz`, `GET /version`, `POST /validate`,
`POST /compile`, `POST /preview` (tenant is used for assets and template lookups only).

Tenant-scoped (tenant required, explicit): all `/templates*`, `/assets*`, `/artifacts/*`, `/render`,
`/jobs/*`. Artifact handles are opaque, 128-bit, and resolved **within** the request tenant; a handle
from another tenant is `TEMPLATE_NOT_FOUND`-equivalent (`ARTIFACT_NOT_FOUND`).

### 3.5 Template resolution (replaces T3)

```
resolve(tenant, documentType, ref):
  ref = {templateId, version}  -> that exact version, tenant-scoped
  ref = "default"              -> the tenant's (tenant, documentType) default
  no default in state          -> NO_DEFAULT_TEMPLATE
```

There is no global fallback. A retired or draft default is a `TEMPLATE_NOT_PUBLISHED` error, never a
fallback. `setDefault` requires a published version.

### 3.6 Lifecycle (extends T1, T2, TS2)

| Operation | Allowed from | Result otherwise |
|---|---|---|
| `saveNextVersion` | any state (creates `draft` at `max+1`) | — |
| `publish` | `draft` | `published` → no-op success (TS2); `retired` → `TEMPLATE_RETIRED` |
| `setDefault` | `published` | `draft`/`retired` → `TEMPLATE_NOT_PUBLISHED` |
| `retire` | `draft` or `published` | `retired` → no-op; retiring the default **clears** the default |
| resolve `"default"` | published default exists | `NO_DEFAULT_TEMPLATE` |

`retire` never deletes content (TS4). A tenant with published versions but no default is a valid
state that fails at `render`, not at `retire`.

### 3.7 Concurrency control (extends T6)

`POST /templates` accepts optional `baseVersion` (integer) and/or `If-Match: "<checksum>"`.

- `baseVersion` ≠ current maximum version → `VERSION_CONFLICT` (409).
- `If-Match` ≠ stored checksum of that version → `VERSION_CONFLICT` (409).
- Both absent → save proceeds (last-writer-wins, documented).

### 3.8 Formatting grammar (replaces §6.3 guidance, C10)

`formatHint` is interpreted **only** by the binder.

| Type | Grammar | Example | Output |
|---|---|---|---|
| `money`, `number` | .NET numeric pattern: literal prefix/suffix + `#`/`0`/`,`/`.` | `#,##0.00` | `1,250.00` |
| | | `€ #,##0.00` | `€ 1,250.00` |
| | | `0` | `1250` |
| `date`, `datetime` | tokens `yyyy yy MM M dd d HH H mm ss`, UTC only | `yyyy-MM-dd` | `2026-03-14` |

Rules:
- Grouping appears **only** if `,` is present in the integer section. `0.00` never groups.
- `money` and `number` inputs MUST be JSON numbers, or decimal strings matching
  `^-?\d+(\.\d+)?$`. Locale-formatted input (`"1,250.00"`) is `TYPE_MISMATCH`.
- Rounding is half-away-from-zero at the declared decimal count.
- No locale, no time zone, no currency conversion. `formatHint` may carry a literal currency
  symbol; multi-currency per document is therefore possible, FX is not.

### 3.9 Header/footer geometry (amends O4, G11, T-12)

- With `preferCssPageSize: true`, the template's `@page` owns **all** geometry.
- When a header or footer is supplied and the request does not set `marginTop`/`marginBottom`,
  the engine applies `headerMargin` / `footerMargin` (default `12mm`) **only if**
  `preferCssPageSize` is `false`.
- Validation emits `HEADER_FOOTER_MARGIN_MISSING` (warning) when a header/footer is in play and
  the main template declares `@page { margin: 0 }` (or no `@page` margin) while
  `preferCssPageSize` is true.
- Clipping is a documented consequence of an explicit zero margin, not a requirement to reproduce.

### 3.10 CSS and markup safety (amends L2, T-18, S-2)

`@media`, `@page`, `@font-face` and inline `style` pass through byte-for-byte.

Rejected, with location (`UNSAFE_MARKUP`):

- `<script>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<form>`;
- `on*=` event attributes;
- `javascript:` and `vbscript:` URLs;
- `srcdoc` attributes.

Rejected, with location (`EXTERNAL_REFERENCE_REJECTED`): any `url(...)`, `@import`, `src=`,
`href=`, or `srcset=` whose target is absolute (`/`), has a scheme (`http:`, `https:`, `file:`,
`data:` except when `PDFER_ALLOW_DATA_URIS=true`), or escapes the bundle.

### 3.11 Time (amends I-9)

Compiled output, provenance and `inputHash` are clock-free. `Template.createdAt` and artifact
timestamps come from an injected `Clock` used **only** by stores. Tests substitute a fixed clock.

### 3.12 Header and footer templates (resolves Appendix E-1)

Header/footer templates are stored in **synthetic document types** named
`<documentType>-header` and `<documentType>-footer`, registered with the same placeholder
schema as the document they decorate.

- `options.headerTemplateRef` / `options.footerTemplateRef` accept `"default"` or an explicit
  `{ templateId, version }`.
- `"default"` resolves the tenant default of `<documentType>-header` / `-footer` when that
  document type is registered; otherwise it resolves the default of `<documentType>`.
- Both are compiled with the same bound model plus reserved tokens (§3.1). Page numbers come
  from the renderer's `pageNumber` / `totalPages` classes, never from Liquid.
- Production renders require the decorator version to be `published`.

---

## 4. New requirements

### 4.1 Data and binding

| ID | Requirement |
|---|---|
| **N1** | **Escape by default.** The binder HTML-escapes every `string` value (`& < > " '`). A schema may declare `dataType: "html"` to opt out; such fields are the caller's responsibility and are reported as a warning in validation. |
| **N2** | `dataType: "html"` is added to the type enumeration. It is never used for `formatHint`. |
| **N3** | `object` values are **not iterable**. `{% for x in someObject %}` is `TYPE_MISMATCH`. Object children are addressable only by declared path, in schema order. |
| **N4** | Reserved names are rejected at registration (`SCHEMA_INVALID`): root tokens `generatedAt`, `documentType`, `title`; loop variables `forloop`, `for`, `if`, `unless`, `assign`, `raw`, `comment`, `endfor`, `endif`. |
| **N5** | Encoding is **UTF-8**. A leading BOM is stripped. CRLF and CR are normalized to LF before checksum, validation and compilation. `checksum` is SHA-256 over the normalized bytes. |
| **N6** | Every string emitted into the model is NFC-normalized Unicode. |

### 4.2 Template language

| ID | Requirement |
|---|---|
| **N7** | Supported tags: `for`, `if`, `elsif`, `else`, `endif`, `unless`, `assign`, `raw`, `comment`. Everything else (`include`, `render`, `capture`, `layout`, `block`, `case`, `cycle`, `increment`, `decrement`, `echo`, `tablerow`) is rejected. |
| **N8** | Supported filters (all others rejected, never silent): `escape`, `escape_once`, `default`, `upcase`, `downcase`, `capitalize`, `strip`, `strip_newlines`, `newline_to_br`, `join`, `size`, `first`, `last`, `truncate`, `append`, `prepend`, `replace`. |
| **N9** | Whitespace control (`{{- -}}`, `{%- -%}`) is supported and part of the parity corpus. `{% raw %}` MUST round-trip literal `{{` / `{%`. |
| **N10** | `forloop.index`, `forloop.index0`, `forloop.first`, `forloop.last`, `forloop.length` are available; `forloop` is shadowed correctly by nested loops. |
| **N11** | Unknown root identifiers, unknown filter names, and filters outside the allow-list are all validation errors with line and column. There is no `allowUnknownTokens` escape hatch in v1.1. |

### 4.3 HTTP surface additions

| ID | Requirement |
|---|---|
| **N12** | `GET /healthz` → `200 {"status":"ok"}` (liveness, no dependencies). |
| **N13** | `GET /readyz` → `200` only when the store is writable and the renderer passes a cached health probe (≤ 10 s TTL); `503` otherwise. |
| **N14** | `GET /version` → `{engine, api, renderer:{image,version}, node}`. Never leaks host paths. |
| **N15** | `GET /metrics` → Prometheus text: render counts by outcome, latency histogram, queue depth, active renders. No labels containing tenant or document type. |
| **N16** | **Async render.** `POST /render` with `Prefer: respond-async` (or `?async=true`) returns `202` + `Location: /v1/jobs/{id}`. `GET /v1/jobs/{id}` → `202` while running, `303` to `/v1/artifacts/{handle}` when done, `4xx/5xx` envelope otherwise. Job metadata is in memory; artifacts are durable. |
| **N17** | `POST /templates` accepts `baseVersion` and honours `If-Match` (§3.7). |
| **N18** | `GET /templates` is paginated: `limit` (default 100, max 500), `cursor`; response `{items, nextCursor}`. |
| **N19** | `POST /compile` and `POST /preview` accept `format: "html" \| "pdf"` (default `pdf` for preview, `html` for compile). `useSampleData: true` together with a non-null `data` is `REQUEST_INVALID`. |
| **N20** | Assets: `PUT /assets/{path}` (raw body, `Content-Type` required) registers an asset for the request tenant and returns `{assetRef, path, mimeType, sha256, size}`. `GET /assets` lists metadata. `assetRef` is tenant-scoped: reuse across tenants is `ASSET_NOT_FOUND`. |
| **N21** | Every response carries `X-Request-Id` (echoed if supplied, else generated). Errors include it in `details`. |
| **N22** | API is mounted at `/v1`; the unprefixed paths in §7 remain as aliases. `GET /` serves a one-page HTML index linking the OpenAPI file and the demo document type. |
| **N22a** | `PDFER_SCHEMAS_FILE` points at a read-only JSON manifest (`{ "schemas": [...] }`) merged into the registry at startup. Schemas stay repo-owned (S1); the manifest lets a deployment add its own document types without forking the image. Invalid manifests abort startup with `SCHEMA_INVALID`. |
| **N22b** | `DELETE /v1/assets/{path}?tenant=` removes one asset and its bytes (`204`), `404 ASSET_NOT_FOUND` when absent. Deleting never affects other tenants. |

### 4.4 Assets

| ID | Requirement |
|---|---|
| **N23** | Assets live at `/data/assets/{tenant}/{assetRef}/{path}`. The resolver cannot read outside that subtree. |
| **N24** | An asset is referenced in a request as `{path, mimeType, assetRef}`; bytes are never sent through `/render`. |
| **N25** | Maximums: single asset 10 MiB, bundle 64 MiB, 256 assets. Exceeding any is `ASSET_TOO_LARGE` / `REQUEST_INVALID`. |
| **N25a** | When a request **omits** `assets` entirely, the engine builds the bundle from every asset path referenced by the template (and any header/footer) that exists in the tenant store. An explicitly supplied `assets` list is authoritative, and any referenced-but-absent path is `ASSET_MISSING`. |

### 4.5 Operations

| ID | Requirement |
|---|---|
| **N26** | Readiness gates on a **cached** renderer probe. A dead renderer makes the container unready but keeps liveness up, so orchestrators restart only when the process itself is wedged. |
| **N27** | The renderer is supervised: if it exits, it is restarted with exponential backoff (1 s → 30 s) and renders fail with `RENDERER_UNAVAILABLE` meanwhile. |
| **N28** | Structured JSON logs, one line per render, containing the provenance tuple; no raw data, no template content. |
| **N29** | Bound queue: `PDFER_MAX_CONCURRENCY` (default 2) and `PDFER_MAX_QUEUE` (default 32). When full → `RENDER_QUEUE_FULL` (503, retriable). |

---

## 5. Error model additions

Existing codes from §13 remain. New/changed:

| Code | Class | HTTP | Retriable | Meaning |
|---|---|---|---|---|
| `NO_DEFAULT_TEMPLATE` | client | 404 | no | No default published for (tenant, documentType) |
| `TEMPLATE_RETIRED` | client | 409 | no | Operation not allowed on a retired version |
| `VERSION_CONFLICT` | client | 409 | no | `baseVersion`/`If-Match` mismatch |
| `UNSAFE_MARKUP` | client | 400 | no | Script/iframe/event handler/JS URL |
| `EXTERNAL_REFERENCE_REJECTED` | client | 400 | no | Absolute or remote asset reference |
| `FILTER_NOT_ALLOWED` | client | 400 | no | Filter outside the allow-list |
| `TAG_NOT_ALLOWED` | client | 400 | no | Tag outside the allow-list |
| `REQUEST_TOO_LARGE` | client | 413 | no | Body over `PDFER_MAX_BODY_BYTES` |
| `DATA_TOO_LARGE` | client | 413 | no | `data` over 32 MiB |
| `OUTPUT_TOO_LARGE` | client | 500 | no | PDF over 100 MiB |
| `RENDER_QUEUE_FULL` | infrastructure | 503 | yes | Concurrency + queue exhausted |
| `ARTIFACT_NOT_FOUND` | client | 404 | no | Unknown/inaccessible artifact handle |
| `ASSET_NOT_FOUND` | client | 404 | no | Unknown asset ref for this tenant |
| `JOB_NOT_FOUND` | client | 404 | no | Unknown async job |
| `RATE_LIMITED` | client | 429 | yes | Per-IP fixed window exceeded (only when enabled) |
| `UNAUTHORIZED` | client | 401 | no | Missing or wrong API key (only when `PDFER_AUTH_MODE=apikey`) |
| `SCHEMA_VERSION_MISMATCH` | client | 400 | no | (unchanged, now reachable via C3) |

Status mapping (replaces H6's incomplete sentence): `422` unparseable body · `400` semantic
rejection · `404` not found · `409` state conflict · `413` too large · `503`/`504` infrastructure.

---

## 6. Resource envelope

The "least resource hungry" target. These are **requirements**, not aspirations.

| ID | Metric | Target | Measured (v1.1 reference build) |
|---|---|---|---|
| **RP1** | Image size | ≤ 1.9 GB | 1.86 GB |
| **RP2** | Container RSS, idle (Chromium asleep after 180 s without a render) | ≤ 420 MB total | ~55 MB (warm within 3 min: ~260 MB) |
| **RP3** | Container RSS, one 3-page invoice in flight | ≤ 700 MB | ~430 MB |
| **RP4** | Container RSS, 10 000-row render | ≤ 1.6 GB; completes ≤ 30 s | 426 MB; 9.0 s (201 pages) |
| **RP5** | Engine process RSS, idle | ≤ 90 MB | ~50 MB |
| **RP6** | Cold start to `/readyz` healthy | ≤ 30 s on 2 vCPU / 2 GB | ~12 s (incl. self-test) |
| **RP7** | Concurrent renders, default | 2, bounded queue 32, no unbounded growth | enforced |
| **RP8** | Idle CPU | < 2 % (no polling loops tighter than 10 s) | 0.1–0.3 % |

**RP1 note.** The image is dominated by the pinned Gotenberg base (Chromium ≈ 381 MB,
LibreOffice ≈ 290 MB, fonts ≈ 160 MB). Deleting LibreOffice in a later layer does **not** shrink
the image (parent layers are retained) and makes Gotenberg fail to start, so it is kept and its
routes are disabled at run time instead. A sub-1 GB image would require building a custom
Gotenberg base, which would break the "pinned, byte-identical renderer" guarantee.

Implementation constraints that follow:

- **One** Chromium instance, driven only by Gotenberg; `--chromium-deny-list=.*` so no outbound
  fetches occur, which also removes the most expensive Chromium paths.
- No second runtime, no JVM, no native modules, no database engine. Node 22 LTS only.
- Templates and artifacts are streamed to/from disk; the engine never holds two copies of a PDF.

---

## 7. Determinism, encoding and hashing

| Property | Definition |
|---|---|
| **K1** | Compiled HTML is byte-identical for identical `(template, model, generatedAt)` across processes, hosts and OSes. |
| **K2** | `checksum` = SHA-256 of LF-normalized UTF-8 template content with BOM removed. |
| **K3** | `inputHash` = SHA-256 of canonical JSON `{html, assets:[{path,sha256}], options}`, keys sorted, no timestamps. |
| **K4** | `dataHash` = SHA-256 of the bound model, canonical JSON. |
| **K5** | PDF bytes are **not** reproducible (G12 stands). Page count and extracted text are. |
| **K6** | No engine-produced output may contain a host path, port, PID, or random identifier except opaque handles. |

---

## 8. Acceptance additions

Every test below is normative and runs in CI against the real container unless marked *fake*.

| ID | Test | Proves |
|---|---|---|
| **T-21** | `docker run` with an empty volume, then `POST /v1/render` with the seeded demo payload returns a PDF whose page count > 0, with all provenance headers present. No configuration was supplied. | Z-1, Z-2, D-10 |
| **T-22** | `GET /readyz` is `503` before the renderer is up and `200` after; `GET /healthz` is `200` throughout. Kill the renderer child: `/healthz` stays `200`, `/readyz` flips to `503`, a render returns `RENDERER_UNAVAILABLE`, and the child is restarted within 30 s. | N12, N13, N26, N27 |
| **T-23** | Template containing `<script>alert(1)</script>`, `<img onerror=…>`, `<iframe>`, and `background:url(https://x/y.png)` is rejected with `UNSAFE_MARKUP` / `EXTERNAL_REFERENCE_REJECTED` **and** locations. A data value containing `<b>x</b>` renders escaped unless `dataType:"html"`. | N1, N5, §3.10 |
| **T-24** | A template saved as CRLF with a BOM and the same template as LF produce the same `checksum` and byte-identical compiled HTML. | N5, K1, K2 |
| **T-25** | `money 1250` + `#,##0.00` → `1,250.00`; `0.00` → `1250.00`; `€ #,##0.00` → `€ 1,250.00`; input `"1,250.00"` → `TYPE_MISMATCH`. Dates use UTC under `TZ=Pacific/Kiritimati`. | §3.8, T-19 |
| **T-26** | Publish v1 → setDefault → publish v2 without setDefault → render `"default"` still yields v1. Retire v1 → render `"default"` → `NO_DEFAULT_TEMPLATE`. Publish a retired version → `TEMPLATE_RETIRED`. | §3.5, §3.6, T-26 |
| **T-27** | `POST /render` with `Prefer: respond-async` → `202` + job id; polling reaches `303` to the artifact; the artifact streams back; the same job id twice returns the same handle. | N16 |
| **T-28** | Two concurrent `POST /templates` with the same `baseVersion` → exactly one succeeds, the other is `VERSION_CONFLICT`. | §3.7 |
| **T-29** | Tenant A uploads an asset and renders with it; tenant B referencing A's `assetRef` gets `ASSET_NOT_FOUND`; B referencing A's artifact handle gets `ARTIFACT_NOT_FOUND`. | N20, N24, §3.4 |
| **T-30** | 10 000-row render completes ≤ 30 s with RSS ≤ 1.6 GB; 60 000 rows → `PAGINATION_LIMIT_EXCEEDED` before the renderer is called. | RP4, I-13 |
| **T-31** | `{% capture %}`, `{% include %}`, `{{ x \| times: 2 }}`, `{% case %}`, `{{ x \| date: "%Y" }}` are each rejected with `TAG_NOT_ALLOWED` / `FILTER_NOT_ALLOWED` and a location. | N7, N8, N11 |
| **T-32** | Renders are deterministic under `TZ`, `LANG=tr_TR.UTF-8`, and `LC_ALL` variations: identical compiled HTML. | I-3, I-9, K1 |
| **T-33** | `docker stop` during an in-flight render exits 0 within 20 s; no partial artifact file remains (temp file removed). | Z-8 |
| **T-34** | `/metrics` exposes render counts and queue depth and contains no tenant or document type strings. | N15 |

---

## 9. Deviations register (v1.0 → v1.1, deliberate)

| v1.0 | v1.1 | Justification |
|---|---|---|
| Ports are "yours to implement" (§6) | Reference implementations ship; ports are override points | Six integration projects is not a viable onboarding |
| `SampleDataProvider` mandatory | Default derives samples from `sampleValue` in the schema | The schema already carries samples (§5.4) |
| Postgres/object store recommended | Filesystem default, adapters optional | Zero config (Z-1, Z-3) and RP1–RP8 |
| Browser parser + server parser parity (T-17) | One parser (liquidjs) used by both; parity is structural, and the browser contract is served by the same package | T-17's column parity was the largest schedule risk |
| Global default template | Removed | §3.5 |
| `allowUnknownTokens` opt-in | Removed | Silent blanks are the failure mode the product exists to prevent |
| Base64 assets permitted as fallback | Not implemented | ADR-8 and I-5; data URIs are rejected by default |

---

## 10. Defaults reference

All optional. Nothing here must be set for a working container.

| Env | Default | Notes |
|---|---|---|
| `PORT` | `8080` | |
| `DATA_DIR` | `/data` | The only volume |
| `PDFER_AUTH_MODE` | `off` | `off` \| `apikey` |
| `PDFER_API_KEY` | — | Required when `apikey` |
| `PDFER_MAX_CONCURRENCY` | `2` | Renderer parallelism |
| `PDFER_MAX_QUEUE` | `32` | Waiting renders before `RENDER_QUEUE_FULL` |
| `PDFER_RENDER_TIMEOUT_MS` | `60000` | |
| `PDFER_RENDER_RETRIES` | `2` | Infrastructure errors only |
| `PDFER_MAX_BODY_BYTES` | `34603008` | 33 MiB |
| `PDFER_MAX_TEMPLATE_BYTES` | `2097152` | 2 MiB |
| `PDFER_MAX_DATA_BYTES` | `33554432` | 32 MiB |
| `PDFER_MAX_ASSET_BYTES` | `10485760` | 10 MiB |
| `PDFER_MAX_BUNDLE_BYTES` | `67108864` | 64 MiB |
| `PDFER_MAX_ROWS` | `50000` | `PAGINATION_LIMIT_EXCEEDED` above |
| `PDFER_SEED_DEMO` | `true` | Only when `/data` is empty |
| `PDFER_SCHEMAS_FILE` | — | Read-only schema manifest merged at startup |
| `PDFER_ALLOW_DATA_URIS` | `false` | |
| `PDFER_ARTIFACT_RETENTION_DAYS` | `0` | `0` keeps forever; `30` is a sane production default |
| `PDFER_RATE_LIMIT_PER_MINUTE` | `0` | Fixed window per client IP; `0` disables |
| `PDFER_LOG_LEVEL` | `info` | |

---

## 11. Definition of done (v1.1)

All 12 items of §16 of the base document, plus:

13. `docker run` with an empty volume serves the demo invoice with no flags (Z-1).
14. Renderer is embedded, loopback-only, and supervised (D-2, D-9, N27).
15. No external service is required (D-8).
16. `T-21` … `T-34` pass.
17. Image ≤ 1.9 GB and idle RSS ≤ 420 MB (RP1, RP2).
18. `schema/openapi.yaml` validates and matches the implemented routes.
19. `README.md` states the escape-by-default rule, the formatHint grammar, the Liquid subset,
     the lifecycle, and every deviation in §9.

---

## 12. Public-deployment hardening

Added in v1.1.1. These apply when the engine is reachable by anything other than a single
trusted backend on a private network.

| ID | Requirement |
|---|---|
| **H-1** | The renderer base image is pinned **by digest**, not by tag. `docker inspect` of a running container MUST match the digest in `Dockerfile`. |
| **H-2** | The container MUST run with `read_only: true`, a writable `/tmp` tmpfs, and `no-new-privileges`. Only `/data` persists. |
| **H-3** | Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, and `Cache-Control: no-store`. Artifacts are never cacheable. |
| **H-4** | API-key comparison is **constant-time** and length-safe. |
| **H-5** | When `PDFER_AUTH_MODE=off`, startup logs a loud warning naming the bind address. The port MUST NOT be published on a public interface without `apikey` or an authenticating proxy. |
| **H-6** | `PDFER_ARTIFACT_RETENTION_DAYS` (default `0`, keep forever) deletes artifact files older than the window at startup and every 6 h. The sweep is logged and counted. |
| **H-7** | `PDFER_RATE_LIMIT_PER_MINUTE` (default `0`, disabled) applies a fixed-window limit per client IP to every non-operational route, returning `429 RATE_LIMITED`. |
| **H-8** | `/metrics` exposes counters, a render-duration histogram (`shows .1/.25/.5/1/2.5/5/10/30/+Inf`), `pdfer_render_queue_depth`, `pdfer_render_active`, and `pdfer_artifacts_removed_total`. |
| **H-9** | TLS is terminated in front of the engine. The container ships no certificate handling and MUST NOT be published as `https`. |

Operational note: the engine is designed to sit behind the calling application, which owns
per-user authentication and quotas. `apikey` is a service-to-service secret, not a user model.

---

## 13. Verification status of this reference implementation

| Item | How it is checked | Result |
|---|---|---|
| Unit + HTTP suite (71 tests, fake renderer) | `npm test` | pass |
| Dialect conformance corpus (36 fixtures) | `node conformance/run.js` | pass |
| Zero-config boot, render, provenance, lifecycle, async, tenancy (28 checks) | `scripts/smoke.sh` | pass |
| Renderer crash → liveness stays up, readiness flips, child restarts | `scripts/renderer-supervision-test.sh` | pass (503 during outage, ready after 3 s) |
| Page text, footer numbering, embedded fonts | `scripts/pdf-assert.js` | 2/2 pages, `Page n of 2` on both |
| 10 000-row volume | `scripts/perf-check.js` | 9.0 s, 201 pages, 426 MB |
| Everything above in one command (WSL) | `scripts/verify.sh` | pass |

The reference implementation is the source of truth for the measured numbers in §6.
