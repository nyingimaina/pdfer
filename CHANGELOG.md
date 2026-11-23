# Changelog

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
