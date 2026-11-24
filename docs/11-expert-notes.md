# Expert notes

For people integrating deeply, debugging output, or maintaining the engine.

## Determinism, precisely

The guarantee is about **compiled HTML**, not PDF bytes.

| Property | Guarantee |
|---|---|
| Compiled HTML | Byte-identical for identical template + model + `generatedAt`, across processes and hosts |
| PDF page count / extracted text | Identical for the same renderer image |
| PDF bytes | **Not** identical — Chromium stamps creation dates, document ids and producer metadata |

Do not write a test that hashes PDFs; it will fail intermittently and teach you
nothing. Golden-file the HTML, assert page counts and text on the PDF.

Determinism is designed in, not incidental:

- no wall clock (the caller supplies `generatedAt`);
- no locale or time zone (formatting is explicit and UTC);
- no environment-dependent ordering (schema order, not map iteration);
- no randomness anywhere in the compile path.

## Hashes and provenance

- `dataHash` = SHA-256 of the bound model, canonical JSON (sorted keys).
- `inputHash` = SHA-256 of `{ html, assets[{path,sha256}], options }` — the
  *inputs*, never the output bytes.
- Provenance pins `templateId`, `templateVersion`, `schemaVersion`, `syntaxId`
  and `rendererImage`.

Re-rendering the same inputs reproduces the compiled document exactly, which is
what makes an archived PDF explainable months later. Keep the provenance tuple
in your own logs; the engine logs it on every production render.

## Renderer pinning

The Gotenberg base is pinned by **digest**, not tag, and the engine reports its
version. Two hosts running the same digest produce the same page count and text.

Upgrading is a deliberate act:

1. build the new image,
2. render a fixture set (a few representative documents),
3. compare page count and extracted text,
4. only then roll.

An unpinned renderer silently changes output on a redeploy; that is the failure
mode this design removes.

## Versioning model

Two independent versions matter, and they are stored, not inferred:

- **template version** — immutable text, created on every save;
- **schema version** — pinned on the template at authoring time.

Rendering a template uses the schema version it was authored against, so
publishing a new schema never retroactively changes an old template. That is why
old documents keep reproducing.

Schemas are additive in practice: add fields, bump the version, leave the old
version registered.

## Performance model

Chromium dominates: compiling is milliseconds, rendering is hundreds. Rough
numbers on 2 vCPU:

| Workload | Time | Memory |
|---|---|---|
| Compile 20 KB template | ≤ 50 ms | negligible |
| Validate | ≤ 100 ms | negligible |
| 3-page invoice | ~1–2 s | ~430 MB |
| 10 000 rows / 201 pages | ~9 s | ~430 MB peak |

Two levers: concurrency (more parallel Chromium conversions) and row count
(more layout work). Concurrency multiplies memory; 2 is a sane default on a
1–2 GB host.

Queue, don't drop: excess renders wait, and beyond the queue they get
`RENDER_QUEUE_FULL` (retriable). That is preferable to unbounded memory.

## Why the single-writer rule exists

Templates are files with atomic renames and an in-process mutex. Version
allocation is `max(version)+1`, then write. One process per volume makes that
correct; two would race. If you need multiple replicas, either shard tenants
across engines or replace the storage port with a transactional store and keep
the same semantics (unique `(tenant, documentType, version)`, one default).

## Extension points

The engine is a library with ports; the container wires filesystem adapters.

| Port | Replace when |
|---|---|
| `TemplateStore` | you need a database, multiple replicas, or existing storage |
| `OutputStore` | artifacts belong in object storage with a lifecycle policy |
| `AssetResolver` | fonts/images live in a CDN or asset service |
| `PdfRenderer` | you must change the renderer (accept losing the pinned image) |
| `SchemaRegistry` | schemas come from a service rather than a manifest |

Keep the semantics, not the implementation: immutability, tenant scoping,
fail-closed binding, bounded rendering.

## Failure taxonomy

Classify before you retry:

- **client errors** (`4xx`): the request or template is wrong; retrying changes
  nothing. Surface the code and location.
- **state conflicts** (`409`): someone must resolve a version or lifecycle
  question.
- **infrastructure** (`503`, `504`, bounded `502`): retry with backoff; the
  request was valid.
- **renderer defects** (`502` with a non-PDF body): investigate, don't retry
  blindly.

Never turn a failure into an empty PDF. A blank document reaching a customer is
worse than an error the caller can handle.

That rule needs an enforcement point at the *renderer* boundary, not only in the
engine. Gotenberg accepts a multipart filename, keeps only its base name (a
path-traversal guard), and treats a failed sub-resource as non-fatal — so a
template could reference `./assets/logo.png`, validate cleanly, render 200, and
lose the image. The adapter therefore uploads assets under flat, content-derived
names, rewrites the references in the copy it renders, and sets
`failOnResourceLoadingFailed`, mapping the renderer's 409 to a non-retriable
`RENDER_RESOURCE_FAILED`. Two consequences worth remembering: the rewrite must
happen after the input hash so `/compile` and provenance stay portable, and any
reference the validator does not extract (`srcset`, `poster`) cannot be
rewritten — it now fails loudly instead of disappearing.

## Testing strategy that works

1. **Golden HTML** for every template construct — cheap, exact, catches drift.
2. **Conformance fixtures** for the language subset (valid, invalid, adversarial).
3. **PDF assertions** on page count and extracted text, never on bytes.
4. **Contract tests** over HTTP, not just the library: status codes and error
   codes are the ABI.
5. **A fake renderer** for unit tests — deterministic bytes and a stub page
   count keep the suite fast and offline.

## What to measure in production

- render duration histogram and failure rate by code;
- queue depth and active renders (saturation);
- renderer restarts (a supervisor event is a warning sign);
- `/data` growth and the retention sweep;
- template versions published (a spike is usually a misconfigured editor).
