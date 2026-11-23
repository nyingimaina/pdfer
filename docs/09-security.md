# Security

Templates are authored by people, sometimes copied from the internet, and are
processed by a browser engine. The design assumes authors are **trusted but
fallible in v1** (staff, not anonymous public users) and still makes three
categories non-negotiable.

## 1. Templates cannot execute code

The template language is a restricted Liquid subset: no includes, no custom
functions, no reflection, no expression syntax from a host language. Values are
data, not code. A template that tries to call something is a validation error.

## 2. Templates cannot leave the document

Compiled HTML runs in Chromium with:

- **JavaScript disabled**;
- **both private and public IP deny rules**, so no network fetch can succeed;
- the process confined to a container with no access to business data;
- local file access left at Chromium's safe default.

A template cannot reach a metadata service, an internal API, or the filesystem.
The only bytes it can use are the assets in its bundle.

Markup that would try is rejected before rendering, with a location:

| Rejected | Why |
|---|---|
| `<script>`, `on*=` handlers, `javascript:`/`vbscript:` URLs, `srcdoc` | active content |
| `<iframe>`, `<object>`, `<embed>`, `<base>`, `<form>` | embedding or navigation |
| absolute or remote `src`/`href`/`url()`/`@import` | egress |
| `data:` URIs (unless explicitly enabled) | bypasses the asset bundle |

`@page`, `@media`, `@font-face` and inline styles pass through — CSS is the
point, and it cannot do any of the above.

## 3. Tenants are isolated

Every template, version, asset and artifact belongs to a tenant, and the tenant
is an explicit parameter on every call. A template id from another tenant is
`TEMPLATE_NOT_FOUND`. Asset paths are confined to the tenant's subtree, and
`..`, absolute paths and URLs are rejected before any filesystem access.

## Values are escaped by default

The binder HTML-escapes every `string`, so a customer name containing markup
cannot change the document's structure. The opt-out is explicit and visible in
the schema: `dataType: "html"`, for content the caller genuinely trusts.

## The API surface

- `PDFER_AUTH_MODE=apikey` compares the bearer token in constant time.
- Responses carry `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  no-referrer`, `X-Frame-Options: DENY`, `Cache-Control: no-store`.
- Every request, body and asset has a size limit, enforced before parsing.
- Errors never include stack traces, SQL, internal paths or hostnames.
- Optional per-IP rate limiting (`PDFER_RATE_LIMIT_PER_MINUTE`).

There is no user model: authentication of people, roles and quotas belong to the
application that calls the engine. Do not expose the engine directly to the
internet; put your backend in front of it.

## Deployment hardening

- Run the container non-root (it is), with a read-only root filesystem and a
  `/tmp` tmpfs.
- Do not publish port 8080 beyond the network your backend uses.
- Terminate TLS at the edge.
- Keep `/data` on a volume with a backup policy; it contains customer templates
  and generated documents.
- Pin the image by tag/digest and record the version in your deploy manifest.

## Limits

| Limit | Default |
|---|---|
| Template | 2 MiB |
| Data payload | 32 MiB |
| Single asset | 10 MiB |
| Asset bundle per render | 64 MiB |
| Output PDF | 100 MiB |
| Collection rows per render | 50 000 |
| Schema nesting | 4 levels |

Exceeding one is a typed error (`TEMPLATE_TOO_LARGE`, `ASSET_TOO_LARGE`,
`PAGINATION_LIMIT_EXCEEDED`, …), never a crash or a silent truncation.

## Out of scope

PDF encryption, redaction, digital signatures, PDF/A and accessibility tagging
are not part of this release. If you need them, add a post-processing stage and
record it in your pipeline explicitly.

## Reporting

If you find a way to make a template read something it should not, or to make
the engine return a document it should have refused, that is a security issue —
report it privately before publishing details.
