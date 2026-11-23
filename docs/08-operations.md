# Operations

## The container

| | |
|---|---|
| Image | `nyingi/pdfer:1.1.0` (`linux/amd64`; the release workflow also builds `arm64`) |
| Port | `8080` — publish it only where trusted clients live |
| Volume | `/data` — templates, versions, assets, generated artifacts |
| User | uid `1001` |
| Base | Gotenberg 8.40.0 (pinned by digest) + Node 22 |

The engine supervises the renderer as a child process on `127.0.0.1:3001`. If it
exits, it is restarted with bounded backoff; renders fail with
`RENDERER_UNAVAILABLE` meanwhile and `/readyz` reports `503`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | |
| `PDFER_DATA_DIR` | `/data` | |
| `PDFER_AUTH_MODE` | `off` | `off` or `apikey` |
| `PDFER_API_KEY` | — | bearer token when `apikey` |
| `PDFER_SCHEMAS_FILE` | — | schema manifest (see [Schemas](05-schemas.md)) |
| `PDFER_SEED_DEMO` | `true` | seed the demo tenant when `/data` is empty |
| `PDFER_ARTIFACT_RETENTION_DAYS` | `0` | delete stored PDFs older than this (0 = keep) |
| `PDFER_RATE_LIMIT_PER_MINUTE` | `0` | per-IP fixed window (0 = off) |
| `PDFER_MAX_CONCURRENCY` | `2` | parallel Chromium conversions |
| `PDFER_MAX_QUEUE` | `32` | waiting renders before `RENDER_QUEUE_FULL` |
| `PDFER_RENDER_TIMEOUT_MS` | `60000` | |
| `PDFER_RENDER_RETRIES` | `2` | infrastructure errors only |
| `PDFER_MAX_BODY_BYTES` | `33 MiB` | |
| `PDFER_MAX_TEMPLATE_BYTES` | `2 MiB` | |
| `PDFER_MAX_DATA_BYTES` | `32 MiB` | |
| `PDFER_MAX_ASSET_BYTES` | `10 MiB` | |
| `PDFER_MAX_BUNDLE_BYTES` | `64 MiB` | |
| `PDFER_MAX_ROWS` | `50000` | collection rows per render |
| `PDFER_LOG_LEVEL` | `info` | |

## Health and metrics

| Endpoint | Meaning |
|---|---|
| `GET /healthz` | the process is alive; no dependencies |
| `GET /readyz` | storage writable and the renderer reachable (cached ≤ 2 s) |
| `GET /version` | engine, API, Node, renderer version |
| `GET /metrics` | Prometheus counters, render-duration histogram, queue depth, active renders |

Alert on `pdfer_renders_total{outcome="failed"}` rising and on
`pdfer_render_queue_depth` staying above zero for long: that is saturation, not
a code bug. `pdfer_artifacts_removed_total` shows the retention sweep working.

## Sizing

Measured on a 2 vCPU host:

| | |
|---|---|
| Idle RSS, Chromium asleep (after 3 min without a render) | **~50–60 MB** |
| Warm RSS (within 3 min of a render, Chromium still up) | ~260 MB |
| One 3-page invoice | ~430 MB |
| 10 000-row table | ~426 MB, ~9 s, 201 pages |
| Cold start to `/readyz` | ~12 s (including the self-test) |
| First render after Chromium sleeps | +1–2 s spent starting Chromium |
| Image | ~1.9 GB |

Start at 1 vCPU / 1 GB, cap concurrency at 2, and scale horizontally only if you
replace the filesystem store (see below).

## Scaling and the single-writer rule

Storage is the filesystem: atomic renames and an in-process lock. That makes one
engine instance per data volume a hard rule. Two replicas sharing a volume can
allocate the same template version concurrently.

If you need more throughput:

- scale the **renderer** side by raising `PDFER_MAX_CONCURRENCY` (watch memory),
- or run several independent engines with independent volumes and route tenants
  to them — tenants are already isolated.

There is no shared-database adapter in this release.

## Backup and retention

`/data` is the state. Back it up as a unit (volume snapshot or `tar`) and restore
it the same way; there is no migration step between versions.

Generated artifacts can be deleted at any time; templates, versions, assets and
the default pointers cannot — losing them loses provenance and designs. Set
`PDFER_ARTIFACT_RETENTION_DAYS` so the volume does not grow forever.

## Upgrades

1. Pull the new tag.
2. Roll the container. Startup validates schemas and renderer health and fails
   fast if something is wrong.
3. If a schema changed, ship the updated manifest **before** templates that use
   it; old templates keep rendering against their pinned schema version.

Rolling back the engine is safe as long as the data volume is intact: versions
are immutable and additive.

## Hardening defaults

- Run with `read_only: true` and a `/tmp` tmpfs; only `/data` is writable.
- `--security-opt no-new-privileges`.
- Do not publish the port beyond your own network; the intended client is your
  backend.
- Terminate TLS in front of whatever calls the engine.

See [Security](09-security.md).
