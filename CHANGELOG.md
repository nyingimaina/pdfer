# Changelog

## 1.1.2 — 2026-11

**Fix: assets referenced as `./assets/<name>` now reach the PDF**
- The renderer writes every uploaded file under its base name only (Gotenberg
  strips directory components as a path-traversal guard), so `./assets/logo.png`
  never resolved. Assets are now uploaded under flat, content-derived names and
  the references in the body, header and footer are rewritten for the render.
- `/compile`, `preview?format=html` and `inputHash` still carry the portable
  `./assets/...` form; nothing about the template syntax changed.
- Affected every template with an image or a custom font, including the seeded
  demo (its `@font-face` sources never resolved; the same fonts being installed
  in the image masked it).

**Fix: a sub-resource that fails to load now fails the render**
- The adapter sets `failOnResourceLoadingFailed` and
  `failOnResourceHttpStatusCodes`, and maps the renderer's 409 to a new
  non-retriable `RENDER_RESOURCE_FAILED` (502). A missing image, font or
  stylesheet is a loud error on the first render instead of a PDF without it.
- Covers references the validator cannot see (`srcset`, `poster`, a linked
  stylesheet's internals), which were previously dropped silently.

**Verification**
- `scripts/verify-assets.sh` renders against a real renderer and asserts the
  image is embedded (body and footer), that `/compile` stays portable, that the
  demo self-test passes with the strict flag on, and that a missing sub-resource
  returns `RENDER_RESOURCE_FAILED`.

## 1.1.1 — 2026-11

**Idle memory**
- `PDFER_RENDERER_IDLE_STOP_SECONDS` (default `0`, off): after that many seconds
  without a render, the engine stops its embedded Gotenberg process. The next
  render starts it again and waits for it, adding ~0.5–1.5 s to that request.
- Chromium already sleeps after 180 s (`--chromium-idle-shutdown-timeout`), so
  idle memory without this flag is ~55 MB; with it, ~30 MB anonymous.
- `/readyz` reports `{"status":"ready","renderer":{"status":"idle"}}` while the
  renderer is stopped on purpose, so orchestrators do not mark the container
  unhealthy.
- Measured and rejected: `--jitless` (breaks `fetch`/undici, which needs
  WebAssembly) and `--max-semi-space-size=1|2` (raises anonymous memory, because
  objects are promoted to old space sooner).

## 1.1.0 — 2026-11

First public release.

**Engine**
- Templates are HTML + a restricted Liquid subset; unsafe markup and remote
  references are rejected at validation with line/column diagnostics.
- Placeholders are declared in a versioned schema manifest, shipped separately
  from the image and loaded with `PDFER_SCHEMAS_FILE`.
- Compiling is pure and deterministic; dates and money are formatted by the
  binder with explicit `formatHint` values in UTC.
- Immutable template versions with publish/default/retire, tenant isolation and
  per-tenant asset libraries.
- Provenance on every render: template version, schema version, renderer
  version and input/data hashes.

**Runtime**
- Single container: the engine supervises a pinned Gotenberg/Chromium child on
  loopback, with JavaScript disabled and private/public IP deny rules.
- Renders are bounded by timeout, retries and a concurrency queue.
- Optional authentication (`apikey`), constant-time key comparison, security
  headers, optional per-IP rate limiting, artifact retention.
- Prometheus metrics, `/healthz`, `/readyz`, graceful shutdown.

**Known limits**
- Single-writer storage: run one engine replica per data volume.
- PDF bytes are not reproducible (Chromium metadata); page count and extracted
  text are.
- The image is ~1.9 GB because it carries Chromium and, unused, LibreOffice.
