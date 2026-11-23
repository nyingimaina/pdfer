# BRS: Templated Document Engine

**Status:** Draft — contract for external implementation
**Audience:** A developer with no prior exposure to the originating codebase
**Document version:** 1.0
**Deliverable type:** Standalone service specification

---

## How to use this document

This document is **self-sufficient**. Everything required to build the engine is
contained here. You are not expected to read, reuse, or be compatible with any
other codebase. Where this document and any other instruction disagree, this
document wins.

Normative keywords, used deliberately:

| Keyword | Meaning |
|---|---|
| **MUST** / **MUST NOT** | An absolute requirement. Violating it fails acceptance. |
| **SHOULD** / **SHOULD NOT** | Strong recommendation. Deviating requires a written reason in your README. |
| **MAY** | Genuinely optional. |

Every requirement has an ID (`R1`, `T3`, `G7`, `I-4`, …). Requirement IDs are
stable and are used by the acceptance tests in §15. If you find a requirement you
cannot satisfy, stop and raise it — do not silently work around it.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Business Context and Rationale](#2-business-context-and-rationale)
3. [How the System Works — Birds-Eye View](#3-how-the-system-works--birds-eye-view)
4. [Architectural Decisions and Why](#4-architectural-decisions-and-why)
5. [Contract: Engine Operations and Data Types](#5-contract-engine-operations-and-data-types)
6. [Contract: Ports You Must Implement](#6-contract-ports-you-must-implement)
7. [Contract: HTTP Surface for a UI](#7-contract-http-surface-for-a-ui)
8. [Template Language: Liquid](#8-template-language-liquid)
9. [Rendering: Chromium via Gotenberg](#9-rendering-chromium-via-gotenberg)
10. [Security Requirements](#10-security-requirements)
11. [Non-Functional Requirements](#11-non-functional-requirements)
12. [Invariants](#12-invariants)
13. [Error Model](#13-error-model)
14. [Build Plan — Do These In Order](#14-build-plan--do-these-in-order)
15. [Acceptance Test Suite](#15-acceptance-test-suite)
16. [Definition of Done](#16-definition-of-done)
17. [Edge Cases and Expected Behaviour](#17-edge-cases-and-expected-behaviour)
18. [Best Practices and Pitfalls](#18-best-practices-and-pitfalls)
- [Appendix A — Full Worked Example](#appendix-a--full-worked-example)
- [Appendix B — Objective-Code Review Checklist](#appendix-b--objective-code-review-checklist)
- [Appendix C — Glossary](#appendix-c--glossary)
- [Appendix D — Reference Stack, Versions, and Local/CI Setup](#appendix-d--reference-stack-versions-and-localci-setup)
- [Appendix E — Decisions Deliberately Deferred](#appendix-e--decisions-deliberately-deferred)

---

## 1. Overview

### 1.1 What we are building

A **document engine**: a service that takes two inputs —

1. a **template** (text, written in a small template language), and
2. **data** (a JSON object),

— and produces a **PDF**.

That is the whole product. Everything else in this document exists to make that
promise safe, repeatable, inspectable, and usable by people who are not
programmers.

```
    ┌────────────────┐        ┌────────────────┐
    │   TEMPLATE     │        │      DATA      │
    │  (text file)   │        │     (JSON)     │
    └───────┬────────┘        └───────┬────────┘
            │                         │
            └───────────┬─────────────┘
                        ▼
              ┌──────────────────┐
              │  COMPILE         │  placeholders replaced,
              │  (pure function) │  loops expanded, conditions
              └────────┬─────────┘  evaluated
                       │
                       ▼
              ┌──────────────────┐
              │  complete HTML   │  ← this is a real, standalone
              │  + CSS document  │    web page. You can open it
              └────────┬─────────┘    in a browser and print it.
                       │
                       ▼
              ┌──────────────────┐
              │  RENDER          │  headless Chromium,
              │  (external       │  reached over HTTP
              │   service)       │
              └────────┬─────────┘
                       │
                       ▼
                  ┌─────────┐
                  │   PDF   │
                  └─────────┘
```

Think of it as **mail merge, but for PDFs, done as a proper service**: one
template, many data payloads, predictable output, and a user interface where a
non-programmer can edit the template and see the result before it is used.

### 1.2 What "engine" means here — the module boundary

The engine is a **library plus an HTTP facade**, not an application. It owns:

- resolving which template to use;
- compiling template + data into HTML;
- asking a PDF renderer for bytes;
- validating templates and reporting precisely what is wrong;
- describing, in machine-readable form, which values a template may use;
- storing/versioning templates (through a port you implement);
- storing generated artifacts (through a port you implement).

It does **not** own:

- any business concept (no invoices, no customers, no stock — those are just
  words in a JSON payload);
- document numbering or sequences;
- user accounts, roles, or permissions beyond "which tenant owns this";
- email or other delivery;
- what the calling system does with the PDF afterwards.

```
┌────────────────────────────────────────────────────────────┐
│  YOUR APPLICATION (owns business data, numbering, users)   │
└───────────────────────────┬────────────────────────────────┘
                            │  "render document type X for tenant Y
                            │   with this JSON payload"
                            ▼
┌────────────────────────────────────────────────────────────┐
│  DOCUMENT ENGINE (this specification)                      │
│                                                            │
│   ┌───────────────┐   ┌──────────────┐   ┌──────────────┐  │
│   │ template      │   │ placeholder  │   │ validation   │  │
│   │ resolution    │   │ schema       │   │ + compile    │  │
│   └───────────────┘   └──────────────┘   └──────────────┘  │
│                                                            │
│   ports you implement:  TemplateStore, SchemaRegistry,     │
│                         SampleDataProvider, AssetResolver,  │
│                         OutputStore, PdfRenderer            │
└───────────────────────────┬────────────────────────────────┘
                            │  HTTP: HTML + asset files
                            ▼
┌────────────────────────────────────────────────────────────┐
│  GOTENBERG (headless Chromium in a container)              │
└────────────────────────────────────────────────────────────┘
```

### 1.3 The sixty-second version

If you read nothing else:

- Templates are **HTML with Liquid placeholders**. Example:
  `<td>{{ item.description }}</td>` and `{% for item in items %} … {% endfor %}`.
- The allowed placeholder names are **declared in a schema**, not discovered by
  reflection. The schema is served over HTTP so a UI can show a field palette.
- **Compiling is pure.** No database writes, no clock, no counters. Therefore
  preview is free and safe.
- Compiled output is a **complete HTML document**. That is your proof of
  correctness: open it in a browser, print to PDF, compare.
- PDF conversion is done by **one pinned Gotenberg container**. You may not
  substitute a different renderer class of tool (specifically: no legacy WebKit
  converters).
- Templates are **immutable versions**. Editing creates `n+1`.
- **Everything is tenant-scoped, and tenant is always an explicit parameter.**
- **Never read the current time.** Callers pass `generatedAt`.
- Every failure has a **stable error code** from §13. Never return an empty PDF.

### 1.4 Who this is for

| Role | What they need from the engine |
|---|---|
| Business user | Edit a template and see a preview without involving developers |
| UI developer | A schema endpoint that lists every available placeholder, and validate/preview endpoints that are cheap to call on every keystroke |
| Application developer | `render()` that takes JSON and returns a PDF, with no side effects and no surprises |
| Operations | One pinned container, clear health check, bounded timeouts, stable error codes |
| Auditor | Provenance on every artifact: which template version, which schema version, which renderer image |

### 1.5 A worked walk-through (read this before §5)

Suppose the calling application wants an invoice PDF.

1. It calls `GET /document-types?tenant=acme`. The engine returns
   `invoice — Invoice — schema v4`.
2. It calls `GET /document-types/invoice/placeholders?version=4` and receives a
   tree describing `invoiceNumber` (string, required), `issuedOn` (date,
   formatted `yyyy-MM-dd`), `items` (collection, loop variable `item`) with
   children `description` and `lineTotal`.
3. A user opens the template editor. The UI draws those placeholders as a
   palette. Clicking one inserts `{{ issuedOn }}`; clicking one inside the
   collection inserts `{{ item.description }}`.
4. On every keystroke, the UI calls `POST /validate` with the draft content. The
   engine answers `200` with either `isRenderable: true` or a list of unknown
   tokens with line numbers. The editor underlines them.
5. The user clicks Preview. The UI calls `POST /preview` with the draft content
   and `useSampleData: true`. The engine compiles with sample data, renders via
   Gotenberg, and streams a PDF back. **No data was persisted. No counter moved.**
6. The user clicks Save. The UI calls `POST /templates`. The engine stores
   version 4 in state `draft`.
7. An administrator calls `POST /templates/{id}/versions/4/publish`. Now
   version 4 is live for tenant `acme`.
8. The application renders the real document: `POST /render` with tenant,
   document type, `"default"` template ref, the real JSON payload, and
   `generatedAt`. The engine pins version 4, compiles, renders, stores the PDF
   via `OutputStore`, and returns a stream plus provenance headers.

That is the complete product loop. Everything below specifies each step.

---

## 2. Business Context and Rationale

### 2.1 The problem this solves

Systems that need PDFs typically start with code that builds a document: strings
concatenated, or a library called with field-by-field arguments. This works until
the first of these happens:

- A customer wants their logo, wording, or columns changed → a developer edits
  code and redeploys.
- A business user wants to change one word → the same.
- A field is missing on some records → the PDF silently shows blank instead of
  failing, and nobody notices until a customer complains.
- The PDF layout needs to be checked → the only way is to generate a real
  document with real data, which may touch counters, sequences, and audit rows.
- Two environments produce different PDFs → nobody knows why.

The engine exists to move all of that out of application code and into
**versioned, validated, previewable templates**, with a contract that makes
failures loud and side effects impossible.

### 2.2 What "done" looks like — goals

| # | Goal | Measured by |
|---|---|---|
| G-1 | A new document kind needs **zero engine code changes** | Register a schema + a template; no deploy of engine logic |
| G-2 | A non-developer can edit a template safely | Palette + validate + preview all work without business data |
| G-3 | Preview can never corrupt data | Zero writes / counters during preview (I-1, I-2) |
| G-4 | A bad template fails in the editor, not in production | Unknown tokens are errors (I-6) |
| G-5 | Any produced PDF can be reproduced | Artifact provenance pins template + schema + renderer (A3, I-8) |
| G-6 | Output is consistent across environments | One pinned renderer image (G1), no clock/locale in output (I-9, L5) |
| G-7 | Failures are diagnosable without reading code | Stable error codes (13), line/column diagnostics (L6) |

### 2.3 Alternatives considered and rejected

These are recorded because a competent developer will ask "why not just…". Each
rejection is a requirement elsewhere in this document.

| Alternative | Why it is rejected |
|---|---|
| **Build PDFs directly in application code** | Every change is a deploy; layout is untestable; no user editing. This is the status quo the engine replaces. |
| **Use the host framework's server-side view engine** (e.g. a C#/Razor-style template that executes code) | Templates become arbitrary programs: **remote code execution** if a user can edit them; CSS `@`-directives must be escaped; requires developer fluency; diagnostics are poor. See L1, L2. |
| **Legacy WebKit HTML-to-PDF converters** | Predate CSS grid and modern flexbox; abandoned; cannot honour contemporary templates. See G3. |
| **Client-side PDF generation (jsPDF, pdfmake, browser print)** | No server-side audit trail; fonts/layout differ per browser; cannot be validated centrally; cannot embed server-known assets. |
| **DOCX templates + office-suite conversion** | Binary templates cannot be diffed or checksummed meaningfully; conversion is slow and layout-fragile; requires an office runtime. |
| **A visual drag-and-drop page designer** | A different product with a different contract: templates would stop being diffable text with checksums. Explicitly out of scope for v1 (§2.4, Appendix E-6). |
| **Base64-inline every asset** | 33% payload inflation, slow font decoding, and divergence from what a browser preview shows. See G7. |
| **Compute totals/filters inside templates** | Untestable business logic in a text file; culture-dependent formatting; providers disagree. See R4, B4. |

### 2.4 Non-goals (out of scope, deliberately)

The engine MUST NOT contain:

- any business entity, rule, lexicon, or default wording;
- any decision about business-visible content: derived totals, filtering or
  ordering rules, or fallback wording. The engine *places* values; it never
  *decides* them (R4, B4);
- document numbering, counters, or sequences;
- roles/permissions beyond tenant scoping;
- delivery (email, printing, storage lifecycle);
- template visual design (drag-and-drop);
- per-tenant custom placeholder schemas (see Appendix E);
- multi-currency or multi-language documents (see Appendix E).

---

## 3. How the System Works — Birds-Eye View

### 3.1 Three stages, five responsibilities

| Stage | Responsibility | Input | Output | Must be |
|---|---|---|---|---|
| **1. Resolve** | Which template? Which schema version? | tenant, document type, template ref | concrete template content + schema | deterministic |
| **2. Bind** | Shape and format the data | raw JSON + schema | model (strings/numbers/booleans/arrays/objects) | strict, fail-closed |
| **3. Compile** | Replace placeholders, expand loops | template + model | complete HTML + CSS | **pure** |
| **4. Render** | HTML → PDF | HTML + assets + options | PDF bytes + page count | isolated, bounded |
| **5. Persist** | Store the artifact | tenant, document type, bytes | handle | only for production |

Rules that fall out of this table:

- **R1 — Purity.** `compile` is a pure function of (template content, model). It
  MUST NOT read the clock, the filesystem, environment variables, or any
  database. Same inputs ⇒ same output, always.
- **R2 — Self-sufficiency.** The compiled document MUST be a complete HTML
  document that renders correctly with the engine completely absent. This is
  both a design constraint and your simplest acceptance test.
- **R3 — Separation.** The render stage receives HTML and assets only. It MUST
  NOT receive the template, the raw data, or the schema. This keeps the renderer
  replaceable and prevents business logic from leaking into it.
- **R4 — No computation.** Templates place values. They do not compute them.
  Totals, filters, sorting, currency conversion, and string assembly happen in
  the caller before the data is submitted. See B4.
- **R5 — Production requires a published version.** `render` in production mode
  MUST reference a persisted, published template version. Inline template
  content is permitted only for `preview`, `compile`, and `validate`.
- **R6 — The engine never persists inline content.** Saving is always an
  explicit, separate operation.

### 3.2 Responsibility matrix

| Concern | Engine | Integrator (you) | Calling application |
|---|---|---|---|
| Template language semantics | ✅ | | |
| Template storage & versioning | defines port | ✅ implements | |
| Placeholder schema declaration | defines contract | ✅ registers | |
| Sample data for preview | defines contract | ✅ implements | |
| Asset resolution (fonts/images) | defines contract | ✅ implements | |
| HTML → PDF | ✅ (via port) | ✅ supplies container | |
| Artifact storage | defines port | ✅ implements | |
| Business data & formatting | | | ✅ |
| Numbering / sequences | | | ✅ |
| Permissions | | | ✅ |
| Deciding which document to render | | | ✅ |

The single most common integration mistake is putting business logic on the wrong
side of this table. When in doubt: if it mentions a business noun, it belongs to
the caller.

### 3.3 A concrete data flow, numbered

```
1.  Caller → POST /render {tenants, documentType, "default", data, generatedAt}
2.  Engine → TemplateStore.resolve(tenant, documentType, "default")
3.  TemplateStore → Template{ id, version, syntaxId:"liquid", content }
4.  Engine → SchemaRegistry.resolve(documentType, schemaVersion)
5.  Engine → DataBinder.bind(data, schema)
6.  DataBinder → model   (typed, formatted, validated)
7.  Engine → TemplateLanguage.compile(template.content, model)
8.  Engine → compiled HTML
9.  Engine → AssetResolver.resolve(each referenced asset)
10. Engine → PdfRenderer.render(html, assets, options)
11. Gotenberg (Chromium) → PDF bytes + page count
12. Engine → OutputStore.save(...)            ← production only
13. Engine → Artifact { stream, provenance, pageCount } → Caller
```

Note what is *absent*: no counter increment, no clock read, no write to business
tables. Step 12 writes only the generated file, only in production mode.

### 3.4 Formatting happens in the binder, not the template

This is the least intuitive rule and the one most likely to be got wrong, so it
gets its own section.

The binder converts semantic values into presentation values:

| Schema type | Model value | Example |
|---|---|---|
| `string` | string | `"INV-2026-00417"` |
| `number` | number | `42` |
| `money` | **string** (formatted) | `"1,250.00"` |
| `date` | **string** (formatted) | `"2026-03-14"` |
| `datetime` | **string** (formatted) | `"2026-03-14 09:41"` |
| `boolean` | boolean | `true` |
| `object` | object | `{ … }` |
| `collection` | array | `[ { … }, { … } ]` |

Why: if a template could format a date, output would depend on the renderer's
locale, and two environments would disagree. By formatting once, in the binder,
with an explicit `formatHint` and an **invariant culture**, the template becomes
a dumb, deterministic string assembler. See B2 and L5.

---

## 4. Architectural Decisions and Why

Each decision is stated as a decision, a rationale, and the consequence you must
accept. If you deviate, you must record why in your README.

### ADR-1 — HTML/CSS is the rendering target; templates compile to HTML

**Decision.** Templates are text that compile into a complete HTML document with
CSS.

**Why.** Every serious PDF engine consumes HTML/CSS; it is the only format where
layout is both expressive and inspectable. Compiled HTML is diffable, viewable in
a browser, and testable without a PDF tool.

**Consequence.** Print behaviour (`@page`, page breaks, print backgrounds) is
expressed in **CSS inside the template**, not as engine options. See G4.

### ADR-2 — One renderer: Gotenberg (headless Chromium), pinned

**Decision.** HTML → PDF is performed only by a Gotenberg container. The image tag
is pinned and verified at startup.

**Why.** Chromium is the only renderer with both modern CSS support and a mature
container offering. Pinning prevents redeploys from silently changing output.

**Consequence.** The engine has an external runtime dependency. You must handle
unavailability and timeouts as first-class errors (§13).

### ADR-3 — Liquid is the template language; Fluid is the reference implementation

**Decision.** `syntaxId` is `"liquid"` in v1. Server implementation: Fluid.

**Why.** Liquid has a maintained **browser-side** parser, which allows the editor
to validate and highlight without a server round-trip — the single biggest factor
in authoring experience. It also has public documentation, a formatter, and a
grammar simple enough to keep diagnostics good. See §8.

**Consequence.** You must keep browser and server parsers in agreement, enforced
by a fixture suite (§8.6). Scriban is a permitted replacement engine behind the
same port; it is not a second dialect.

### ADR-4 — Templates are text, immutable, versioned

**Decision.** Every save creates a new version. Published versions never change.

**Why.** Reproducibility, auditability, and safe rollback. Text is diffable and
checksummable; binary formats are not.

**Consequence.** You must never "edit in place". Storage grows per version; that
is the correct trade.

### ADR-5 — Placeholders are declared, not discovered

**Decision.** Each document type registers a versioned `PlaceholderSchema`.

**Why.** A UI cannot offer a palette, autocomplete, or unknown-token detection
without a declared list. Reflection over arbitrary objects couples the engine to
host types and produces unusable labels.

**Consequence.** Adding a placeholder requires a schema version bump. That is
intended: schemas are contracts.

### ADR-6 — Rendering is pure; preview requires no data

**Decision.** `preview` and `compile` perform no writes and accept sample data.

**Why.** Without this, "preview" either corrupts data or is impossible. This is
the decision that makes a real editor possible.

**Consequence.** Numbering and derived values move to the caller. Sample data
providers become mandatory.

### ADR-7 — Tenant and time are explicit parameters

**Decision.** `tenant` and `generatedAt` are required inputs on every render.
Never inferred from headers, sessions, or the system clock.

**Why.** Determinism, testability, and background-job safety. An engine that
reads ambient context cannot be tested with two clocks or two tenants.

**Consequence.** Callers must pass them. That is a feature.

### ADR-8 — Assets are transmitted as files, not data URIs

**Decision.** Fonts, images, and stylesheets travel as additional files in the
same request, referenced by relative path.

**Why.** No 33% inflation; correct font loading; identical behaviour between
browser preview and final render.

**Consequence.** You must build and validate an explicit asset bundle (§6.5, G6–G8).

### ADR-9 — Headers and footers are templates

**Decision.** Page headers and footers are compiled by the same engine and passed
to the renderer as separate HTML documents.

**Why.** Portable page numbering. Chromium's support for CSS `@page` margin boxes
is version-dependent; a footer document with `pageNumber`/`totalPages` is not.

**Consequence.** Two more template references per render; validation must warn on
hand-rolled page counters.

### ADR-10 — Keep the renderer port even though there is one renderer

**Decision.** `PdfRenderer` remains an interface.

**Why.** Three concrete reasons: tests need a deterministic fake; HTTP failure
modes belong in one seam; timeouts, retries, and concurrency limits need one
home. Swap-ability is a bonus, not the justification.

**Consequence.** Do not "simplify" it away. See Appendix B.

### ADR-11 — Validation is a normal response, not an exception

**Decision.** `POST /validate` returns `200` with a verdict. `422` is reserved
for malformed requests.

**Why.** Editors call validation continuously. "Your template is wrong" is a
normal state, not a protocol error.

**Consequence.** Clients must branch on `isRenderable`, not on status code.

### ADR-12 — No builder pattern for the request

**Decision.** `RenderRequest` is a flat, JSON-serialisable value object.

**Why.** It is the public contract, crosses process boundaries, and must be
loggable. Builder chains hide defaults and make provenance hard.

**Consequence.** Defaults are documented, not implicit (§5.7).

---

## 5. Contract: Engine Operations and Data Types

Everything in this section is the public API. Types are shown as JSON for
precision; implement them as your language's idiomatic data structures.

### 5.1 Operations

```
DocumentEngine
  listDocumentTypes(tenant)                       -> DocumentTypeDescriptor[]
  getPlaceholderSchema(documentType, version?)    -> PlaceholderSchema
  getTemplate(templateRef, tenant)                -> Template
  validate(ValidateRequest)                       -> ValidationReport
  compile(CompileRequest)                         -> string            // HTML
  render(RenderRequest)                           -> Artifact
  renderTo(writableStream, RenderRequest)         -> Artifact (no bytes field)
```

Requirements:

- **R7** — every operation MUST be asynchronous and MUST accept a cancellation
  token that propagates all the way to the renderer HTTP call.
- **R8** — no operation may be blocking at the interface boundary. No
  `.Result`, no `GetAwaiter().GetResult()`, no equivalent.
- **R9** — `validate` MUST NOT throw for invalid templates. It returns a report.
- **R10** — `compile` MUST NOT perform I/O beyond the ports it needs
  (`SchemaRegistry`, `DataBinder`, `AssetResolver`). It MUST NOT render.
- **R11** — `render` MUST be safe to retry. It is idempotent with respect to
  inputs; the only side effect is `OutputStore.save` in production mode, and
  duplicate saves must be tolerated (overwrite or dedupe by `inputHash`).

### 5.2 Common conventions

| Convention | Rule |
|---|---|
| `tenant` | Opaque string, 1–64 chars, `[a-z0-9][a-z0-9_-]*`. Never numeric-only, never empty. |
| `documentType` | `^[a-z][a-z0-9-]{1,63}$`. Stable, never renamed. |
| `templateId` | Opaque string, ≤ 64 chars. |
| `schemaVersion`, `template version` | Positive integers, monotonically increasing. |
| Timestamps | RFC 3339 with `Z`, e.g. `2026-03-14T08:00:00Z`. Always UTC. |
| Money | Emitted as formatted strings by the binder. No currency arithmetic in the engine. |
| Booleans | JSON `true`/`false`. Never `"true"`. |
| Nulls | Allowed only where the schema marks `isRequired: false`. |
| Unknown fields in requests | MUST be rejected with `REQUEST_INVALID` (fail closed, not ignore). |

### 5.3 `DocumentTypeDescriptor`

```json
{
  "documentType": "invoice",
  "displayLabel": "Invoice",
  "description": "Customer-facing sales invoice",
  "placeholderSchemaVersion": 4,
  "supportedSyntaxes": ["liquid"],
  "supportsPreview": true,
  "templateCount": 3,
  "defaultTemplateId": "tpl_8f21"
}
```

| Field | Required | Meaning |
|---|---|---|
| `documentType` | ✅ | Stable key. |
| `displayLabel` | ✅ | Human-facing name for a picker. |
| `description` | ❌ | One sentence. |
| `placeholderSchemaVersion` | ✅ | The current schema version. |
| `supportedSyntaxes` | ✅ | In v1 this is exactly `["liquid"]`. |
| `supportsPreview` | ✅ | `false` only if no `SampleDataProvider` is registered. |
| `templateCount` | ✅ | Number of non-retired templates for the tenant. |
| `defaultTemplateId` | ❌ | `null` if the tenant has none published. |

`listDocumentTypes` returns only types registered in the `SchemaRegistry`. It
MUST NOT return an empty array silently if the registry is empty — that is a
configuration error and MUST surface as `SCHEMA_REGISTRY_EMPTY`.

### 5.4 `PlaceholderSchema` and `PlaceholderDescriptor`

The schema is the object the UI renders as a field palette. It MUST be derivable
without rendering anything and without any business data.

```json
{
  "documentType": "invoice",
  "schemaVersion": 4,
  "root": [
    {
      "path": "invoiceNumber",
      "token": "invoiceNumber",
      "displayLabel": "Invoice number",
      "group": "Header",
      "dataType": "string",
      "isCollection": false,
      "isRequired": true,
      "formatHint": null,
      "sampleValue": "INV-2026-00417",
      "children": []
    },
    {
      "path": "issuedOn",
      "token": "issuedOn",
      "displayLabel": "Issue date",
      "group": "Header",
      "dataType": "date",
      "isCollection": false,
      "isRequired": true,
      "formatHint": "yyyy-MM-dd",
      "sampleValue": "2026-03-14",
      "children": []
    },
    {
      "path": "items",
      "token": "items",
      "displayLabel": "Line items",
      "group": "Lines",
      "dataType": "collection",
      "isCollection": true,
      "isRequired": false,
      "formatHint": null,
      "sampleValue": null,
      "loopVariable": "item",
      "children": [
        {
          "path": "items[].description",
          "token": "item.description",
          "displayLabel": "Description",
          "group": "Lines",
          "dataType": "string",
          "isCollection": false,
          "isRequired": true,
          "formatHint": null,
          "sampleValue": "Consulting services",
          "children": []
        },
        {
          "path": "items[].lineTotal",
          "token": "item.lineTotal",
          "displayLabel": "Line total",
          "group": "Lines",
          "dataType": "money",
          "isCollection": false,
          "isRequired": true,
          "formatHint": "0.00",
          "sampleValue": "1,250.00",
          "children": []
        }
      ]
    }
  ]
}
```

**Field rules**

| Field | Rule |
|---|---|
| `path` | Canonical dotted path. Collection members use `[]` (e.g. `items[].description`). MUST be unique across the whole schema. |
| `token` | The exact text a template must contain. For collection children this is only valid **inside** the loop over the parent, using its `loopVariable`. |
| `displayLabel` | Required, non-empty, human wording. This is what the palette shows. |
| `group` | Optional grouping for UI presentation (`Header`, `Lines`, `Totals`). |
| `dataType` | One of `string`, `number`, `money`, `date`, `datetime`, `boolean`, `object`, `collection`. Anything else is a configuration error. |
| `isCollection` | `true` iff `dataType == "collection"`. Implementations MUST validate this consistency at registration. |
| `loopVariable` | Required when `isCollection`. MUST match `^[a-z][a-zA-Z0-9_]*$` and MUST be unique within the schema. |
| `isRequired` | If `true`, a render missing this value fails validation. |
| `formatHint` | Declarative formatting consumed by the binder only. Never interpreted by the template. |
| `sampleValue` | Yes for preview. MUST be a valid representation of the type. Collections use `null` and supply samples in children. |
| `children` | MUST be non-empty iff `dataType` is `collection` or `object`; MUST be empty otherwise. |

**Schema registration rules**

- **S1** — schemas are registered in code at startup, never authored by users.
- **S2** — a schema change increments `schemaVersion`; existing versions remain
  resolvable so old templates keep rendering (I-8).
- **S3** — the registry MUST reject, at startup, any schema that violates the
  field rules above (`SCHEMA_INVALID`), rather than failing on first render.
- **S4** — `root` MUST be an array. Nesting depth MUST be ≤ 4 levels of
  collections/objects. Reject deeper schemas: they produce unusable palettes and
  pathological templates.

### 5.5 `Template` and `TemplateRef`

```json
{
  "templateId": "tpl_8f21",
  "tenant": "acme",
  "documentType": "invoice",
  "version": 3,
  "displayLabel": "Invoice — blue header",
  "syntaxId": "liquid",
  "state": "published",
  "isDefault": true,
  "checksum": "sha256:9c1f…",
  "contentLengthBytes": 18422,
  "createdAt": "2026-02-01T09:14:00Z",
  "createdBy": "u_5521",
  "content": "<!doctype html>…"
}
```

`TemplateRef` is either:

```json
{ "templateId": "tpl_8f21", "version": 3 }
```
or the literal string `"default"`.

**Lifecycle**

```
        save (new)                publish                retire
  ──────────────────► draft ──────────────► published ──────────────► retired
                        │                      │   ▲
                        │  save (new version)  │   │ setDefault on another
                        ▼                      ▼   │ version of same type
                      draft                  published(default)
```

| State | Renderable in production | Editable | Notes |
|---|---|---|---|
| `draft` | ❌ (`TEMPLATE_NOT_PUBLISHED`) | ✅ (as a new draft) | Work in progress |
| `published` | ✅ | ❌ (immutable) | May or may not be the default |
| `retired` | ❌ (`TEMPLATE_NOT_PUBLISHED`) | ❌ | Kept for provenance |

**Rules**

- **T1** — a published version is immutable. Editing creates `n+1` as `draft`.
  Attempting to modify a published version MUST fail with
  `TEMPLATE_IMMUTABLE`.
- **T2** — at most one template per (tenant, documentType) may be both
  `published` and `isDefault`. `setDefault` MUST clear the previous default in
  the same transaction.
- **T3** — resolving `"default"` means: the tenant's default; if the tenant has
  no published template at all, the global default; otherwise error. It MUST NOT
  silently fall through to a global template when the tenant has published
  templates.
- **T4** — a `TemplateRef` belonging to another tenant resolves to
  `TEMPLATE_NOT_FOUND`. Never a fallback, never a partial success.
- **T5** — the resolved (templateId, version) MUST be recorded in the artifact's
  provenance.
- **T6** — `checksum` is the SHA-256 of the content bytes, computed on save and
  returned on read. Clients MAY use it to detect concurrent edits.

### 5.6 `RenderRequest`

```json
{
  "tenant": "acme",
  "documentType": "invoice",
  "mode": "production",
  "template": "default",
  "data": {
    "invoiceNumber": "INV-2026-00417",
    "issuedOn": "2026-03-14",
    "items": [
      { "description": "Consulting services", "lineTotal": "1,250.00" }
    ]
  },
  "generatedAt": "2026-03-14T08:00:00Z",
  "options": {
    "preferCssPageSize": true,
    "landscape": false,
    "printBackground": true,
    "scale": 1.0,
    "nativePageRanges": null,
    "waitForExpression": null,
    "waitDelay": null,
    "failOnHttpStatusCodes": [499, 500, 501, 502, 503, 504],
    "headerTemplateRef": null,
    "footerTemplateRef": { "templateId": "tpl_footer_a", "version": 2 },
    "metadata": { "title": "Invoice INV-2026-00417" }
  },
  "assets": [
    { "path": "assets/Inter.woff2", "mimeType": "font/woff2", "assetRef": "asset_01" }
  ],
  "output": { "fileName": "INV-2026-00417.pdf" },
  "format": "pdf"
}
```

| Field | Required | Default | Rule |
|---|---|---|---|
| `tenant` | ✅ | — | Must match the resolved template's tenant (`TENANT_MISMATCH`). |
| `documentType` | ✅ | — | Must match the resolved template's document type. |
| `mode` | ✅ | — | `preview` or `production`. Controls purity and persistence (I-1, R5). |
| `template` | ⚠️ | — | Exactly one of `template` or `inlineTemplate`. |
| `inlineTemplate` | ⚠️ | — | `{ syntaxId, content, displayLabel? }`. Preview/compile/validate only. |
| `data` | ✅ | — | Must conform to the schema. Unknown keys are an error. |
| `generatedAt` | ✅ | — | RFC 3339. The engine never reads the clock (I-9). |
| `options` | ❌ | §5.7 defaults | See §5.7 for defaults and rules. |
| `assets` | ❌ | `[]` | Explicit and finite. Nothing outside this may be fetched (I-5). |
| `output.fileName` | ❌ | derived | Hint only. The engine sanitises it; filename **collision handling is the caller's concern**. |
| `format` | ❌ | `pdf` | `pdf` or `html`. `html` returns compiled HTML and skips the renderer. |

**Why `mode` exists.** It is the single switch that guarantees preview cannot
write. Implementations MUST enforce purity in code, not by trusting callers: a
`preview` request MUST be rejected with `PREVIEW_SIDE_EFFECT_DENIED` if any port
attempts a mutating call while it is in flight.

### 5.7 `RenderOptions`

These map 1:1 to renderer request fields. **An option that is accepted and then
ignored is a defect** (I-12, G5).

| Option | Type | Default | Effect |
|---|---|---|---|
| `preferCssPageSize` | boolean | `true` | When true, `@page` in the template owns page size and margins. |
| `paperWidth` / `paperHeight` | string (mm/in) | `210mm` / `297mm` | Used only when `preferCssPageSize` is false. |
| `marginTop`/`Bottom`/`Left`/`Right` | number (mm) | `0` | Used only when `preferCssPageSize` is false. |
| `landscape` | boolean | `false` | Orientation override. |
| `printBackground` | boolean | `true` | Print background colours/gradients. |
| `scale` | number | `1.0` | Render scale, 0.1–2.0. |
| `nativePageRanges` | string | `null` | e.g. `"1-3,5"`. `null` = all pages. |
| `waitForExpression` | string | `null` | JS expression that must evaluate truthy before conversion. |
| `waitDelay` | string | `null` | Duration to wait after load, e.g. `"500ms"`. |
| `failOnHttpStatusCodes` | number[] | `[499,500,501,502,503,504]` | Statuses that must abort the conversion. |
| `headerTemplateRef` | TemplateRef | `null` | Compiled and sent as the header document. |
| `footerTemplateRef` | TemplateRef | `null` | Compiled and sent as the footer document. |
| `metadata` | object | `{}` | PDF metadata: `title`, `author`, `subject`, `keywords`. |

**Rules**

- **O1** — `preferCssPageSize` MUST default to `true`. Engine-supplied margins
  MUST NOT silently override a template's own `@page`.
- **O2** — an unsupported option value MUST fail with
  `RENDER_OPTION_UNSUPPORTED` rather than degrade.
- **O3** — header/footer templates are compiled with the **same schema**, plus
  the reserved placeholders in §5.12.
- **O4** — margins for header/footer MUST be honoured: a header document needs a
  top margin, a footer a bottom margin, or it will be clipped.

### 5.8 Asset bundle

```json
{
  "path": "assets/Inter.woff2",
  "mimeType": "font/woff2",
  "assetRef": "asset_01"
}
```

| Rule |
|---|
| **AB1** — `path` is relative, forward-slashed, and MUST NOT contain `..`, a leading `/`, a scheme, or a drive letter. |
| **AB2** — `path` must be exactly what the template references (`./assets/Inter.woff2` ⇒ `assets/Inter.woff2`). |
| **AB3** — only assets in this bundle may be reachable during render (I-5). |
| **AB4** — the bundle MUST be self-sufficient. Relying on fonts installed in the renderer image beyond the declared baseline is a defect (`ASSET_MISSING`). |
| **AB5** — total bundle size is bounded (§11). |

### 5.9 `CompileRequest`, `ValidateRequest`, `inlineTemplate`

```json
{
  "tenant": "acme",
  "documentType": "invoice",
  "inlineTemplate": {
    "syntaxId": "liquid",
    "content": "<!doctype html>…",
    "displayLabel": "Draft from editor"
  },
  "data": { "…": "…" },
  "generatedAt": "2026-03-14T08:00:00Z"
}
```

```json
{
  "tenant": "acme",
  "documentType": "invoice",
  "inlineTemplate": { "syntaxId": "liquid", "content": "…" },
  "data": null,
  "schemaVersion": 4
}
```

`data: null` means "validate against the schema only", using sample data where a
value is needed to determine a type.

### 5.10 `ValidationReport`

```json
{
  "isRenderable": false,
  "schemaVersion": 4,
  "syntaxErrors": [
    {
      "code": "UNCLOSED_SECTION",
      "message": "Section 'for' opened at line 118 is not closed",
      "location": { "line": 118, "column": 7 }
    }
  ],
  "unknownTokens": [
    {
      "token": "invoiceDate",
      "location": { "line": 42, "column": 31 },
      "suggestion": "issuedOn"
    }
  ],
  "unusedPlaceholders": [{ "token": "poReference" }],
  "missingAssets": [{ "path": "assets/logo.svg" }],
  "schemaMismatches": [
    {
      "token": "item.lineTotal",
      "expectedType": "money",
      "receivedType": "string",
      "location": { "line": 73, "column": 18 }
    }
  ],
  "warnings": [
    {
      "code": "HARDCODED_PAGE_NUMBER",
      "message": "Page numbering must be produced by the footer template",
      "location": { "line": 12, "column": 9 }
    }
  ]
}
```

| Rule |
|---|
| **V1** — validation never throws for a bad template; it returns a report. |
| **V2** — `isRenderable` is `true` iff a production render with sample data would succeed. |
| **V3** — unknown tokens are errors with line and column, plus a suggestion when an edit-distance-2 match exists. Silent empty-string substitution is forbidden unless `allowUnknownTokens: true` is explicitly set (and then each substitution is reported as a warning). |
| **V4** — `unusedPlaceholders` and `warnings` never affect `isRenderable`. |
| **V5** — validation is schema-version-pinned. Validating a template authored against v3 while the registry is at v4 MUST report the mismatch explicitly (`SCHEMA_VERSION_MISMATCH`) rather than reinterpret tokens. |
| **V6** — every diagnostic carries a stable `code`. Messages are for humans and may change; codes may not. |

### 5.11 `Artifact`

```json
{
  "documentType": "invoice",
  "fileName": "INV-2026-00417.pdf",
  "contentType": "application/pdf",
  "byteLength": 48213,
  "pageCount": 3,
  "provenance": {
    "templateId": "tpl_8f21",
    "templateVersion": 3,
    "schemaVersion": 4,
    "syntaxId": "liquid",
    "rendererImageTag": "8.24.1",
    "inputHash": "sha256:41ab…",
    "dataHash": "sha256:7d02…"
  },
  "warnings": []
}
```

| Rule |
|---|
| **A1** — `pageCount` is required for `format: "pdf"`. Take it from the renderer; do not write a bespoke PDF parser to discover it. |
| **A2** — `inputHash` covers compiled HTML + asset bundle checksums + render options. It identifies **inputs**, never output bytes. |
| **A3** — provenance must be sufficient to re-render the same compiled document later. |
| **A4** — `byteLength` must equal the actual byte count. A zero-length or truncated PDF MUST never be returned as success (I-14). |

### 5.12 Reserved placeholders

Available in every schema, injected by the engine, never declared by an
integrator:

| Token | Scope | Value |
|---|---|---|
| `generatedAt` | main, header, footer | The supplied RFC 3339 timestamp, formatted with `formatHint` `yyyy-MM-dd HH:mm` in UTC by default. |
| `documentType` | main, header, footer | The document type key. |
| `pageNumber` | header, footer only | Current page number (1-based). |
| `totalPages` | header, footer only | Total page count. |
| `title` | header, footer only | `options.metadata.title`, else `documentType`. |

Using `pageNumber`/`totalPages` in the main template MUST produce a
`HARDCODED_PAGE_NUMBER` warning (G10).

### 5.13 What the engine MUST NOT accept

Reject with `REQUEST_INVALID`, always:

- unknown top-level fields;
- `template` and `inlineTemplate` together;
- `mode: "production"` with `inlineTemplate`;
- `template` referencing a draft or retired version;
- `data` containing keys not in the schema;
- `assets` with absolute paths or traversal;
- `generatedAt` absent or not UTC;
- `tenant` mismatch against the resolved template.

---

## 6. Contract: Ports You Must Implement

Six ports. Each is an interface you implement and the engine consumes. The engine
ships **test doubles** for all six; use them in your own tests.

### 6.1 `TemplateStore`

```
list(tenant, documentType)                   -> Template[]        // metadata only
get(templateRef, tenant)                     -> Template | null
resolve(tenant, documentType, templateRef)   -> Template          // applies T3
saveNextVersion(template)                    -> TemplateRef       // always creates n+1
publish(templateRef, tenant)                 -> void
setDefault(templateRef, tenant)              -> void
retire(templateRef, tenant)                  -> void
```

| Rule |
|---|
| **TS1** — `saveNextVersion` MUST never mutate an existing version. It computes `max(version)+1` atomically (unique index on `(tenant, documentType, version)`). |
| **TS2** — `publish` on an already-published version is a no-op success (idempotent). |
| **TS3** — `setDefault` MUST clear any other default for that (tenant, documentType) atomically. |
| **TS4** — `retire` MUST NOT delete content; provenance depends on it. |
| **TS5** — `resolve` MUST apply T3/T4 and return a fully-populated `Template` including `content`. |

Minimum viable implementation: one table with a unique index on
`(tenant, document_type, version)` and a partial/unique constraint guaranteeing at
most one default.

### 6.2 `SchemaRegistry`

```
register(documentType, schemaVersion, PlaceholderSchema, sampleDataProvider?)
resolve(documentType, schemaVersion?) -> PlaceholderSchema
listDocumentTypes()                   -> DocumentTypeDescriptor[]
```

| Rule |
|---|
| **SR1** — registration happens at startup; an invalid schema aborts startup with `SCHEMA_INVALID`. |
| **SR2** — resolving an unknown `(documentType, schemaVersion)` fails with `SCHEMA_VERSION_UNKNOWN`. |
| **SR3** — resolving with no version returns the latest registered version. |
| **SR4** — all registered versions remain resolvable forever (I-8). |

### 6.3 `DataBinder`

```
bind(rawData, PlaceholderSchema) -> model
```

| Rule |
|---|
| **B1** — unknown keys in `rawData` are an error (`UNKNOWN_DATA_KEY` and a `schemaMismatches` entry). They are never ignored. |
| **B2** — the emitted model contains only `string`, `number`, `boolean`, `null`, arrays, and objects of those. `date`/`datetime`/`money` are emitted as **formatted strings**, using `formatHint` and an **invariant culture**. Locale and time-zone inference are forbidden. |
| **B3** — `isRequired: true` with an absent value is an error (`REQUIRED_PLACEHOLDER_MISSING`). |
| **B4** — the binder performs no computation beyond validation and formatting. No totals, no sorting, no filtering, no currency maths. |
| **B5** — collection members are bound with the same rules recursively. |

**Formatting guidance** (declare it in your README and keep it stable):

| Schema type | Recommended `formatHint` semantics |
|---|---|
| `date` | ICU/`strftime`-style pattern, e.g. `yyyy-MM-dd` |
| `datetime` | e.g. `yyyy-MM-dd HH:mm` |
| `money` | Number pattern, e.g. `0.00` (thousands separators per explicit configuration, default: enabled) |
| `number` | Number pattern, e.g. `0.###` |

### 6.4 `SampleDataProvider`

```
sampleFor(documentType, schemaVersion) -> rawData
```

| Rule |
|---|
| **SD1** — MUST return data that satisfies every `isRequired` placeholder. |
| **SD2** — collections MUST contain at least two members so loop layout is visible in preview. |
| **SD3** — samples MUST be obviously fake (`EXAMPLE`, `INV-0000`, adjacent dates) so a preview cannot be mistaken for a real document. |
| **SD4** — MUST NOT read business data. A preview with sample data must work on a fresh install. |

### 6.5 `AssetResolver`

```
resolve(assetRef) -> { path, bytes, mimeType }
```

| Rule |
|---|
| **AR1** — resolution is confined to a configured asset root. |
| **AR2** — `..`, absolute paths, `file://`, and `http(s)://` are rejected (`ASSET_REJECTED`). |
| **AR3** — a configured maximum file and total bundle size is enforced (`ASSET_TOO_LARGE`). |
| **AR4** — missing files fail with `ASSET_MISSING` naming the path, never a silent omission. |

### 6.6 `OutputStore`

```
save(tenant, documentType, fileName, bytes) -> handle
open(handle) -> readableStream
```

| Rule |
|---|
| **OS1** — `save` is called **only** in production mode. Preview/compile MUST
  never call it (I-1). |
| **OS2** — `fileName` is sanitised by the engine (`[A-Za-z0-9._ -]`, max 180
  chars, no leading dots); the store MUST NOT trust it blindly. |
| **OS3** — repeated saves with the same `inputHash` must be idempotent
  (overwrite or dedupe). |
| **OS4** — `open` must stream; do not require the whole file in memory (§11). |

### 6.7 `PdfRenderer`

```
render(html, assets, options) -> { bytes, pageCount }
health()                      -> { ok, imageTag }
```

| Rule |
|---|
| **PR1** — exactly one implementation ships. No provider selection, no
  discovery by probing. |
| **PR2** — the implementation MUST pass a cancellation token through to the
  HTTP request (P1). |
| **PR3** — an HTTP failure, timeout, or non-PDF response MUST map to the codes
  in §13, never to a zero-byte success. |
| **PR4** — `health()` MUST report the renderer's image tag so startup can assert
  the pin (G1). |
| **PR5** — the port exists for tests, failure isolation, and timeout/concurrency
  enforcement. It MUST NOT be removed because there is one implementation
  (ADR-10). |

---

## 7. Contract: HTTP Surface for a UI

The engine MUST expose this surface. If you are building the engine as a library
only, build it anyway — it is the contract a UI is written against, and it is how
you demonstrate the product.

| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/document-types?tenant=` | — | `DocumentTypeDescriptor[]` |
| GET | `/document-types/{key}/placeholders?version=` | — | `PlaceholderSchema` |
| GET | `/document-types/{key}/sample-data` | — | raw data object |
| GET | `/templates?documentType=&tenant=&state=` | — | `Template[]` (metadata, no content) |
| GET | `/templates/{templateId}?version=` | — | `Template` (with content) |
| POST | `/templates` | `{ tenant, documentType, sourceTemplateId?, syntaxId, content, displayLabel }` | `{ templateId, version }` |
| POST | `/templates/{templateId}/versions/{v}/publish` | — | `204` |
| POST | `/templates/{templateId}/versions/{v}/default` | — | `204` |
| POST | `/templates/{templateId}/versions/{v}/retire` | — | `204` |
| POST | `/validate` | `ValidateRequest` | `ValidationReport` (always `200`) |
| POST | `/compile` | `CompileRequest` | `text/html` |
| POST | `/preview` | `CompileRequest` + `useSampleData` | `application/pdf` \| `text/html` |
| POST | `/render` | `RenderRequest` | stream + provenance headers |
| GET | `/artifacts/{handle}` | — | stream |

**Rules**

| Rule |
|---|
| **H1** — `/validate` returns `200` with a report for any well-formed request. `422` is reserved for a malformed request. An editor calls `/validate` on every keystroke and must distinguish "your template is wrong" from "I sent nonsense". |
| **H2** — `/preview` accepts `useSampleData: true` and requires no business data. |
| **H3** — `/render` rejects `inlineTemplate` with `INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION`. |
| **H4** — every endpoint is tenant-scoped; `tenant` is required and explicit. No header sniffing, no ambient context. |
| **H5** — `/render` responds with the artifact stream plus headers: `X-Template-Version`, `X-Schema-Version`, `X-Renderer-Image`, `X-Input-Hash`, `X-Page-Count`. |
| **H6** — errors are JSON: `{ "error": { "code", "message", "location?", "details?", "retriable" } }`. HTTP status: `400` for invalid requests, `404` for not-found, `409` for state conflicts (immutability, tenant mismatch), `503` for renderer unavailability, `504` for renderer timeout. |
| **H7** — request bodies are limited per §11 and MUST be rejected before parsing past the limit. |

**Example**

```bash
curl -X POST https://engine.example.com/render \
  -H 'content-type: application/json' \
  -d '{
    "tenant": "acme",
    "documentType": "invoice",
    "mode": "production",
    "template": "default",
    "data": {
      "invoiceNumber": "INV-2026-00417",
      "issuedOn": "2026-03-14",
      "items": [{ "description": "Consulting", "lineTotal": "1,250.00" }]
    },
    "generatedAt": "2026-03-14T08:00:00Z"
  }' \
  --output invoice.pdf -D -
```

---

## 8. Template Language: Liquid

### 8.1 Why Liquid

| Criterion | Liquid | Why it matters here |
|---|---|---|
| Browser-side parser | Maintained, produces an AST | Live editor validation without a server round-trip |
| Learnability | Large public documentation corpus | Users can find examples; support load drops |
| Formatting | Prettier plugin exists | Saved templates stay diffable |
| Sandboxing | No host-code execution | Absolute requirement (L1) |
| CSS compatibility | `{{ }}`/`{% %}` do not collide with `@` directives | No escaping hacks (L2) |
| Diagnostics | Parser exceptions carry line/column | Editor gutters (L6) |

**Reference server implementation:** Fluid. **Permitted replacement:** Scriban,
behind the `TemplateLanguage` port, only if §8.6 still passes. **Forbidden:**
Scriban's Liquid compatibility mode as a second dialect.

### 8.2 Mandatory language requirements

| ID | Requirement |
|---|---|
| **L1** | **No host-code execution.** Templates cannot call functions outside a fixed filter/section allow-list, reflect over types, read files, open sockets, or write anything. |
| **L2** | **HTML/CSS transparency.** `@page`, `@media`, `@font-face`, `@import`, and inline `style` MUST pass through unmodified. No escaping convention (e.g. doubling `@`) may be required. |
| **L3** | **Sections, iteration, conditionals, filters.** `{% for %}`, `{% if %}`, `{% assign %}`, and the filter subset in §8.3 MUST be supported. |
| **L4** | **HTML-only output.** A syntax that cannot emit HTML/CSS is out of scope. |
| **L5** | **No implicit formatting.** No locale, currency, or time-zone inference. |
| **L6** | **Line/column diagnostics** for every syntax error. |
| **L7** | **Dialect parity** between browser and server parsers (§8.6). |

### 8.3 Supported subset (be explicit in your README)

**MUST support**

- `{{ path }}` — output a value
- `{{ path.property }}` — nested access
- `{% for item in items %} … {% endfor %}` — iteration, with `forloop.index`, `forloop.first`, `forloop.last`
- `{% if cond %} … {% elsif cond %} … {% else %} … {% endif %}`
- `{% assign x = expr %}`
- `{% unless cond %} … {% endunless %}`
- Comparisons: `==`, `!=`, `<`, `>`, `<=`, `>=`, `and`, `or`, `contains`
- Filters: `escape`, `default`, `upcase`, `downcase`, `capitalize`, `strip`,
  `join`, `size`, `first`, `last`, `truncate`, `append`, `prepend`, `replace`

**MUST reject** (validation error, not silent)

- `{% include %}`, `{% render %}` — no partials in v1 (they need a template loader
  and break the self-sufficiency property R2)
- `{% capture %}` — encourages logic in templates
- Custom filters/functions outside the allow-list
- Any host-language expression syntax

`escape` MUST be available and SHOULD be used for user-supplied text, but note:
Liquid does not auto-escape. Document this. For document rendering the input is
usually already trusted business data; still, `escape` is the correct tool for
free-text fields.

### 8.4 Formatting discipline

Templates MUST NOT format values. These are all violations:

```liquid
{{ issuedOn | date: "%d/%m/%Y" }}        ❌ formatting in template
{{ lineTotal | times: 1.14 }}            ❌ computation in template
{{ name | downcase | replace: " ", "-" }} ❌ transformation in template
```

Correct:

```liquid
{{ issuedOn }}      ✅ already "2026-03-14"
{{ lineTotal }}     ✅ already "1,250.00"
```

Formatting exceptions: purely presentational case/whitespace filters
(`upcase`, `strip`, `escape`) are acceptable because they cannot change a value's
meaning or its numeric/date interpretation. Anything that changes meaning is the
binder's job (B4).

### 8.5 A complete, correct template

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 0; }
      @font-face {
        font-family: "Inter";
        src: url("./assets/Inter.woff2") format("woff2");
      }
      body {
        font-family: "Inter", sans-serif;
        padding: 18mm 16mm;
        margin: 0;
        font-size: 10pt;
        color: #1f2937;
      }
      h1 { font-size: 20pt; margin: 0 0 4mm; }
      .meta { color: #6b7280; font-size: 9pt; margin-bottom: 8mm; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 2mm 0; border-bottom: 0.2mm solid #e5e7eb; }
      th.amount, td.amount { text-align: right; }
      .footer-note { margin-top: 8mm; font-size: 8pt; color: #9ca3af; }
    </style>
  </head>
  <body>
    <h1>{{ title }}</h1>
    <p class="meta">
      Invoice {{ invoiceNumber }}
      &middot; issued {{ issuedOn }}
    </p>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="amount">Total</th>
        </tr>
      </thead>
      <tbody>
        {% for item in items %}
        <tr>
          <td>{{ item.description }}</td>
          <td class="amount">{{ item.lineTotal }}</td>
        </tr>
        {% endfor %}
      </tbody>
    </table>

    {% if notes %}
      <p class="footer-note">{{ notes }}</p>
    {% endif %}
  </body>
</html>
```

**Footer template** (`footerTemplateRef`):

```html
<div style="width:100%; font-size:8pt; color:#9ca3af; text-align:center;">
  Page <span class="pageNumber"></span> of <span class="totalPages"></span>
</div>
```

Note: `pageNumber`, `totalPages`, and `title` are inserted **by the renderer**,
not by Liquid. They are plain HTML spans with reserved class names. Do not wrap
them in Liquid syntax.

### 8.6 Dialect parity suite (mandatory)

A fixture corpus — valid, invalid, and adversarial — MUST be evaluated by both the
browser parser and the server implementation. For each fixture both must return:

- the same accepted/rejected verdict;
- the same set of unknown tokens;
- the same set of syntax-error locations (line **and** column);
- the same interpretation of sections, iteration, conditionals, and filters.

Run it in CI. This is the only defence against editor/renderer drift, and it is
what allows the server engine to be replaced later without changing the authoring
experience.

Fixture categories you must cover:

1. every supported construct from §8.3;
2. every rejected construct from §8.3;
3. unbalanced sections, unclosed output tags, bad filter arguments;
4. unknown tokens, including near-miss suggestions;
5. collection semantics: nested loops, `forloop.index`, empty collections;
6. escaping and HTML passthrough (`@media`, `@font-face`, `@import`, `style=`).

### 8.7 Editor expectations (what the API must enable)

The UI needs, per keystroke, without rendering:

- parse errors with line/column;
- unknown tokens with line/column and suggestions;
- the palette, from `PlaceholderSchema`;
- the ability to insert collection children only inside their loop.

If your API cannot drive those four things cheaply, the contract is not
satisfied, regardless of how correct `render` is.

---

## 9. Rendering: Chromium via Gotenberg

### 9.1 What Gotenberg is

A container that accepts an HTML file (plus additional asset files) over HTTP and
returns a PDF produced by headless Chromium.

```
POST {baseUrl}/forms/chromium/convert/html
Content-Type: multipart/form-data
```

### 9.2 Pinning and health

| ID | Requirement |
|---|---|
| **G1** | The image tag MUST be pinned (e.g. `gotenberg/gotenberg:8.24.1`) and asserted at startup via `GET /health`. An unpinned image silently changes render output. |
| **G2** | Exactly one renderer implementation ships. No provider selection, no probing, no discovery by scanning ports. Base URL, timeout, and concurrency are configuration. |
| **G3** | Legacy WebKit-based HTML-to-PDF converters are prohibited. They predate CSS grid and modern flexbox. |

Startup MUST fail fast if the renderer is unreachable or reports a different
image tag than configured.

### 9.3 Exact request contract

Build a `multipart/form-data` request with:

| Form field | Value |
|---|---|
| `files` | The compiled HTML. The filename **must** be `index.html`. |
| `files` | Each asset, with the filename set to its relative path, e.g. `assets/Inter.woff2`. This is how relative references resolve. |
| `files` | Optional `header.html` and/or `footer.html` (exact names). |
| `preferCssPageSize` | `"true"` by default. |
| `printBackground` | `"true"`. |
| `landscape` | `"true"`/`"false"`. |
| `scale` | e.g. `"1"`. |
| `paperWidth` / `paperHeight` | e.g. `"210mm"`, `"297mm"` — only when `preferCssPageSize` is false. |
| `marginTop` / `marginBottom` / `marginLeft` / `marginRight` | e.g. `"0"` in inches, or millimetres where your client uses mm — **match the renderer's documented unit exactly**. |
| `nativePageRanges` | `"1-3"` or omitted. |
| `waitForExpression` | JS expression, optional. |
| `waitDelay` | e.g. `"500ms"`, optional. |
| `failOnHttpStatusCodes` | JSON array, e.g. `[499,500,501,502,503,504]`. |
| `metadata` | JSON object string, e.g. `{"title":"Invoice INV-1"}`. |

**Unit trap.** Gotenberg's margin fields are in **inches**, while paper size is
usually given as a CSS length (`mm`). Convert explicitly and unit-test the
conversion. A silent unit mistake produces plausible-looking but wrong output.

The response body is the PDF bytes. `Content-Type` must be `application/pdf`;
anything else is `RENDER_FAILED`.

### 9.4 Options are passed through, never dropped

- **G4** — `preferCssPageSize` MUST be `true` by default. CSS `@page` owns page
  geometry. Engine margins MUST NOT silently override a template's own setup.
- **G5** — an option the renderer cannot honour MUST fail the request
  (`RENDER_OPTION_UNSUPPORTED`), not be ignored.

This requirement exists because the most common implementation bug in this area is
accepting an options object and never forwarding it. Add a test per option field
(I-12, T-10).

### 9.5 Assets

- **G6** — assets are transmitted as **files** in the same request, preserving
  relative paths.
- **G7** — base64 data-URI inlining MUST NOT be the default. It inflates payloads
  by ~33%, is slow for fonts, and diverges from what a browser preview shows.
  Permitted only as an explicit fallback.
- **G8** — the bundle must be self-sufficient. A missing font produces
  `ASSET_MISSING`, never a silent substitution.

### 9.6 Headers and footers

- **G9** — headers and footers are templates compiled by the same engine, using
  the same schema plus reserved placeholders (§5.12).
- **G10** — page numbering in the main template's CSS is prohibited. Chromium's
  support for `@page` margin boxes is version-dependent; a footer document with
  `pageNumber`/`totalPages` is the portable mechanism. Validation emits
  `HARDCODED_PAGE_NUMBER`.
- **G11** — a header requires a top margin and a footer a bottom margin, or
  Chromium clips them. Set `marginTop`/`marginBottom` accordingly when a
  header/footer template is supplied.

### 9.7 Determinism — what it does and does not mean

- **G12** — PDF bytes are **not** byte-reproducible. Chromium stamps creation
  dates, document IDs, and producer metadata.

Therefore:

| Property | How it is defined |
|---|---|
| Determinism of compiled HTML | Byte-identical for identical template + data + `generatedAt` (I-3) |
| Determinism of PDF | Same page count, same extracted text, same embedded fonts (I-10) |
| Reproducibility of a document | Provenance pins template version + schema version + renderer image; re-render reproduces compiled HTML exactly |
| Archival byte-identity | Out of scope. If needed, add a separate PDF/A normalisation stage and declare it. |

Do **not** write a test asserting identical PDF checksums. It will fail
intermittently and you will waste a day.

### 9.8 Timeouts, retries, concurrency

| Rule |
|---|
| **G13** — every render has a configurable timeout (default 60 s). On expiry: `RENDER_TIMEOUT`, retriable with backoff. |
| **G14** — retries are bounded (default: 2) and only for infrastructure-class errors. Never retry a template/schema/validation error. |
| **G15** — concurrency is bounded per renderer instance (default: 4). Excess requests queue; they are never dropped silently and never run unbounded. |
| **G16** — a health check gates startup and SHOULD gate readiness. Unhealthy renderer ⇒ `RENDERER_UNAVAILABLE` (retriable), not a 500 with a stack trace. |

---

## 10. Security Requirements

| ID | Requirement | Attack it prevents |
|---|---|---|
| **S-1** | Templates cannot execute host code (§8.2 L1). | Template author runs arbitrary code on your server |
| **S-2** | Chromium egress is deny-by-default. Configure the renderer's Chromium allow/deny lists so only the request's assets are reachable; leave local-file access **disabled** (the default). | SSRF: a template renders `http://169.254.169.254/…` or `file:///etc/passwd` and the PDF exfiltrates it |
| **S-3** | Asset paths are resolved only inside a configured root; `..`, absolute paths, and URLs are rejected (AR2). | Path traversal / reading arbitrary files |
| **S-4** | Every operation is tenant-scoped and tenant is explicit (H4, T4). | Cross-tenant template read or render |
| **S-5** | Production renders require a persisted published version (R5). | Unauditable output; rendering arbitrary client-supplied HTML as a trusted document |
| **S-6** | Templates are stored as text with checksums (T6). | Undetectable tampering; non-attributable changes |
| **S-7** | The renderer runs in an isolated container with no access to business data stores. | A renderer compromise escalating to data compromise |
| **S-8** | Request bodies and asset bundles are size-limited (§11). | Memory exhaustion and decompression bombs |
| **S-9** | Error messages never echo the full asset path outside the configured root, nor internal hostnames. | Information disclosure |

**Explicit threat model statement:** the engine assumes template authors are
*trusted but fallible* in v1 (staff, not anonymous public users). Even so, S-1
through S-3 are non-negotiable, because "trusted" authors copy snippets from the
internet.

---

## 11. Non-Functional Requirements

### 11.1 Limits

| Item | Limit |
|---|---|
| Template size | ≤ 2 MiB |
| Data payload | ≤ 32 MiB |
| Single asset | ≤ 10 MiB |
| Asset bundle total | ≤ 64 MiB |
| Output PDF | ≤ 100 MiB |
| Collection rows per render | Support 10 000; declared hard maximum ≥ 50 000 |
| Schema nesting depth | ≤ 4 levels of collection/object |
| HTTP request body | ≤ 32 MiB (configurable, enforced before parsing) |

- **P1** — limits are configuration, documented, and enforced with the codes in
  §13 — never by crashing or by truncating silently.

### 11.2 Performance

| Metric | Target |
|---|---|
| Compiled HTML only (no render) | p95 ≤ 50 ms for a 20 KB template |
| Typical 3-page invoice, end to end | p95 ≤ 5 s |
| 10 000-row table, single document | ≤ 30 s, ≤ 1 GiB renderer memory |
| `/validate` on a 20 KB template | p95 ≤ 100 ms |

### 11.3 Scaling rules

- **P2** — the engine is stateless and reentrant. No shared mutable state between
  renders; concurrency limits belong to the transport/renderer (G15).
- **P3** — streaming: `renderTo(stream)` MUST not buffer the whole PDF twice.
  `OutputStore.open` returns a stream.
- **P4** — cancellation MUST abort the renderer HTTP call, not just the caller's
  wait (R7, PR2).
- **P5** — the engine MUST behave correctly with zero templates, one template,
  and 10 000 template versions. Pagination on `/templates` is required beyond
  100 rows.

---

## 12. Invariants

These are the properties the product promises. Each MUST have an executable test
(§15 cross-references).

| # | Invariant | Verified by |
|---|---|---|
| **I-1** | **Purity.** `preview` and `compile` perform no writes, consume no sequences, emit no events. | T-02 |
| **I-2** | **No business effect.** Rendering, previewing, or validating never advances any counter. | T-02 |
| **I-3** | **HTML determinism.** Same template + data + `generatedAt` ⇒ byte-identical compiled HTML across processes. | T-03 |
| **I-4** | **No code execution.** Adversarial templates render literally or fail validation; they never execute or read anything. | T-04 |
| **I-5** | **No egress.** A render cannot reach any origin outside the supplied asset bundle, including link-local/metadata addresses. | T-05 |
| **I-6** | **Fail-fast tokens.** Unknown tokens are validation errors with line/column. Empty substitution requires explicit opt-in. | T-06 |
| **I-7** | **Tenant isolation.** Another tenant's template reference yields not-found, never a fallback. | T-07 |
| **I-8** | **Version pinning.** Rendering version 3 after 4 is published reproduces version 3's compiled HTML. | T-08 |
| **I-9** | **Explicit time.** The engine never reads the wall clock; omitting `generatedAt` is an error. | T-09 |
| **I-10** | **PDF equivalence.** The same compiled HTML produces the same page count and extracted text on any renderer instance. | T-10 |
| **I-11** | **Compiled independence.** Open the compiled HTML in a browser, print to PDF ⇒ the same page count as the engine's render (±0). | T-01 |
| **I-12** | **No silent option drops.** Every option either affects output or fails the request. | T-10 |
| **I-13** | **Bounded resources.** 10 000 rows render within budget; exceeding the hard maximum returns `PAGINATION_LIMIT_EXCEEDED`, never OOM. | T-13 |
| **I-14** | **Fail loudly.** Renderer unavailability, timeout, and conversion failure are distinct codes; no empty or truncated PDF is ever returned as success. | T-14 |
| **I-15** | **Dialect parity.** Browser and server parsers agree on verdicts, unknown tokens, and error locations. | T-17 |
| **I-16** | **CSS transparency.** `@media`, `@page`, `@font-face`, `@import` pass through unmodified. | T-18 |

---

## 13. Error Model

Envelope:

```json
{
  "error": {
    "code": "UNKNOWN_TOKEN",
    "message": "Unknown token 'invoiceDate' at line 42",
    "location": { "line": 42, "column": 31 },
    "details": { "suggestion": "issuedOn" },
    "retriable": false
  }
}
```

| Code | Class | Retriable | Meaning |
|---|---|---|---|
| `REQUEST_INVALID` | client | no | Malformed request, unknown field, bad enum |
| `TEMPLATE_NOT_FOUND` | client | no | No such template for this tenant |
| `TEMPLATE_NOT_PUBLISHED` | client | no | Draft/retired referenced in production |
| `TEMPLATE_IMMUTABLE` | client | no | Attempt to edit a published version |
| `TEMPLATE_TOO_LARGE` | client | no | Over the template size limit |
| `TEMPLATE_SYNTAX_ERROR` | client | no | Parser error (also in `syntaxErrors`) |
| `UNKNOWN_TOKEN` | client | no | Placeholder not in the schema |
| `TYPE_MISMATCH` | client | no | Value does not match the declared type |
| `REQUIRED_PLACEHOLDER_MISSING` | client | no | Required value absent |
| `UNKNOWN_DATA_KEY` | client | no | `data` contains a key not in the schema |
| `SCHEMA_VERSION_UNKNOWN` | client | no | No such schema version |
| `SCHEMA_VERSION_MISMATCH` | client | no | Template authored for another schema version |
| `SCHEMA_INVALID` | server config | no | Registration-time schema defect (aborts startup) |
| `SCHEMA_REGISTRY_EMPTY` | server config | no | No document types registered |
| `ASSET_MISSING` | client | no | Referenced asset not resolvable |
| `ASSET_REJECTED` | client | no | Unsafe path/URL |
| `ASSET_TOO_LARGE` | client | no | Over the asset size limit |
| `PAGINATION_LIMIT_EXCEEDED` | client | no | Collection exceeds the hard maximum |
| `TENANT_MISMATCH` | client | no | Request tenant ≠ template tenant |
| `INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION` | client | no | R5 violation |
| `PREVIEW_SIDE_EFFECT_DENIED` | client | no | A mutating port call was attempted in preview |
| `RENDER_OPTION_UNSUPPORTED` | client | no | Option cannot be honoured |
| `RENDERER_UNAVAILABLE` | infrastructure | **yes** (backoff) | Renderer down/unreachable |
| `RENDER_TIMEOUT` | infrastructure | **yes** (backoff) | Renderer exceeded the timeout |
| `RENDER_FAILED` | infrastructure | **yes** (bounded) | Renderer returned an error or non-PDF |
| `OUTPUT_WRITE_FAILED` | infrastructure | **yes** | Artifact store write failed |
| `INTERNAL_ERROR` | server | yes | Unexpected; never leaks stack traces to clients |

**Rules**

- **E1** — codes are stable and documented. Messages may change.
- **E2** — validation aggregates diagnostics into a `ValidationReport`; `render`
  reports the first fatal error.
- **E3** — client-class errors are never retried automatically.
- **E4** — an infrastructure error never produces a partial artifact.
- **E5** — `INTERNAL_ERROR` responses never include stack traces, SQL, file
  paths outside the asset root, or hostnames.

---

## 14. Build Plan — Do These In Order

Each milestone is independently demonstrable. Do not start the next until the
current one's demo works. This ordering exists so you never debug two unknown
things at once.

### M0 — Walking skeleton (target: day 1–2)

**Build:** A handler that accepts HTML, posts it to Gotenberg, returns PDF bytes.
No templates, no schema, no persistence.

**Demo:** `curl` an HTML string, get a PDF that opens.

**Proves:** G1, G2, and that your HTTP client, units, and container wiring work.

**Do not** proceed until the unit conversion (mm vs inches) is verified against a
ruler on a printed A4 page.

### M1 — Compile only, no PDF (day 3–5)

**Build:** `TemplateLanguage` port + Liquid implementation. `compile(template,
model)` → HTML string. Hard-code one template and one data object in a test.

**Demo:** `compile` a hard-coded template with hard-coded data; diff the output
against a golden file.

**Proves:** L1–L6, R1, I-3.

### M2 — Schema and sample data (day 5–7)

**Build:** `PlaceholderSchema`, `SchemaRegistry`, `SampleDataProvider`,
`DataBinder`. Startup validation of schemas (S3/S4).

**Demo:** `GET /document-types` and `GET /document-types/{key}/placeholders`
return the descriptor tree; `sample-data` returns a payload that compiles against
the sample template.

**Proves:** ADR-5, B1–B5, SR1–SR4.

### M3 — Validate (day 7–9)

**Build:** `validate` producing the full `ValidationReport`, including unknown
tokens with suggestions, unused placeholders, missing assets, and schema
mismatches.

**Demo:** Deliberately break a template four ways; the report names each problem
with a line number.

**Proves:** V1–V6, I-6, L6.

### M4 — Store and version (day 9–12)

**Build:** `TemplateStore`, `OutputStore`, versioning, publish/default/retire.

**Demo:** Save v1, publish, save v2, publish, render v1 by explicit ref, confirm
output matches v1, confirm v1 is uneditable.

**Proves:** T1–T6, R5, I-7, I-8.

### M5 — Full render (day 12–15)

**Build:** `render` end to end: resolve → bind → compile → assets → Gotenberg →
`OutputStore` (production only) → artifact + provenance.

**Demo:** A real invoice PDF with a footer page number, embedded webfont, and
provenance headers.

**Proves:** R1–R11, G6–G12, A1–A4.

### M6 — Preview purity (day 15–16)

**Build:** `mode: preview` with recording ports; assert zero mutating calls.

**Demo:** Preview through the UI; show the store logs contain zero writes.

**Proves:** I-1, I-2, I-11.

### M7 — Hardening (day 16–20)

**Build:** limits, timeouts, retries, concurrency, egress lockdown, health checks,
rate limits if needed.

**Demo:** Kill the renderer mid-flight; observe `RENDERER_UNAVAILABLE` and a clean
retry. Attempt SSRF; observe rejection.

**Proves:** S-2, S-8, G13–G16, I-5, I-13, I-14.

### M8 — Editor contract (day 20–22)

**Build:** nothing new — only confirm the API drives a real editor: palette,
live validation, preview, save/publish.

**Demo:** Build a throwaway single-page editor (a textarea, a palette, an iframe)
in a few hours. If that is painful, the contract is wrong — fix the contract, not
the editor.

**Proves:** §8.7 and the whole point of the project.

---

## 15. Acceptance Test Suite

The suite MUST run in CI with the renderer container started by the harness. Each
test below is normative.

**T-01 — Compiled independence (I-11, R2)**
*Given* a template and data, *when* `compile` is called, *then* the result
contains no `{{` or `{%`, is a complete HTML document, and printing it in a
headless browser yields the same page count as `render` (±0).

**T-02 — Preview purity (I-1, I-2)**
*Given* recording `TemplateStore`/`OutputStore`, *when* `/preview` is called with
`useSampleData: true`, *then* zero `save`/`publish`/`emit` calls occur and no
counter advances.

**T-03 — HTML determinism (I-3)**
*Given* a fixed request, *when* `compile` runs in two separate processes, *then*
outputs are byte-identical.

**T-04 — No code execution (I-4, S-1)**
*Given* templates containing a host-language expression, a `<script>` block,
`__proto__`/`constructor` traversal, and `../../etc/passwd`, *when* validated and
compiled, *then* each either fails validation with a location or renders the text
literally; no process spawn, file read, or socket occurs.

**T-05 — No egress (I-5, S-2)**
*Given* a template referencing `http://169.254.169.254/latest/meta-data/` and
`file:///etc/passwd`, *when* rendered, *then* the render fails with
`ASSET_REJECTED`/`ASSET_MISSING` and the network boundary observes no outbound
request.

**T-06 — Unknown token (I-6, V3)**
*Given* a template with `{{ invoiceDate }}` while the schema has `issuedOn`,
*when* validated, *then* `isRenderable` is `false`, `unknownTokens` contains
`invoiceDate` with line/column and suggestion `issuedOn`.

**T-07 — Tenant isolation (I-7, T4)**
*Given* tenant A's template id, *when* tenant B requests it, *then*
`TEMPLATE_NOT_FOUND` and no global fallback occurs.

**T-08 — Version pinning (I-8, T1)**
*Given* versions 3 and 4, *when* version 3 is rendered after 4 is published,
*then* compiled HTML matches version 3's golden file, and editing 3 is rejected
with `TEMPLATE_IMMUTABLE`.

**T-09 — Explicit time (I-9)**
*Given* `generatedAt` omitted, *then* the request fails with
`REQUEST_INVALID`/`REQUIRED_PLACEHOLDER_MISSING`; *given* two different
`generatedAt` values with identical data, *then* only timestamp-dependent output
differs.

**T-10 — Renderer options (I-10, I-12, G4, G5)**
*Given* a template declaring `@page { size: A5; margin: 0 }` and
`preferCssPageSize: true`, *then* pages are A5 and content is not inset;
*given* an unsupported option value, *then* `RENDER_OPTION_UNSUPPORTED`;
*given* the same HTML on two renderer instances, *then* page count and extracted
text match.

**T-11 — Assets (G6–G8)**
*Given* a template referencing `./assets/Inter.woff2` and `./assets/logo.png`,
*then* the declared fonts are embedded, assets are transmitted as files (not
data URIs), and a missing file yields `ASSET_MISSING` naming the path.

**T-12 — Page numbering (G9–G11, L6)**
*Given* a main template containing `counter(page)` and a footer template using
`pageNumber`/`totalPages`, *then* validation emits `HARDCODED_PAGE_NUMBER` and
the PDF footer shows correct numbers on every page; *given* a header template
with `marginTop: 0`, *then* the header is clipped — demonstrating G11.

**T-13 — Volume (I-13, P1–P3)**
*Given* 10 000 rows, *then* the render completes within the latency/memory budget
and reports the correct page count; *given* rows above the hard maximum, *then*
`PAGINATION_LIMIT_EXCEEDED`.

**T-14 — Failure modes (I-14)**
*Given* the renderer stopped, timing out, and returning 5xx, *then* codes are
`RENDERER_UNAVAILABLE`, `RENDER_TIMEOUT`, `RENDER_FAILED`, each with the correct
retriability, and no zero-byte PDF is returned.

**T-15 — HTTP semantics (H1–H7)**
*Given* a well-formed request with a broken template, `/validate` returns `200`
with `isRenderable: false`; *given* a malformed body, `422`; *given*
`inlineTemplate` on `/render`, `INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION`.

**T-16 — Schema evolution (V5, SR4)**
*Given* a template authored against schema v3 while the registry is at v4,
*then* validation reports `SCHEMA_VERSION_MISMATCH`; rendering with an explicit
`schemaVersion: 3` still succeeds.

**T-17 — Dialect parity (I-15, §8.6)**
*Given* the fixture corpus, *when* both parsers evaluate it, *then* verdicts,
unknown-token sets, and error locations are identical for every fixture.

**T-18 — CSS transparency (I-16, L2)**
*Given* a template containing `@page`, `@media`, `@font-face`, `@import`, and
`style="..."`, *when* compiled, *then* those constructs appear in the output
byte-for-byte, with no escaping artifacts.

**T-19 — Layout-value correctness (§3.4, B2)**
*Given* `money` `1250` and `date` `2026-03-14` with hints `0.00` and
`yyyy-MM-dd`, *when* compiled, *then* the model contains the strings `"1,250.00"`
and `"2026-03-14"`, and no template-side formatting is required.

**T-20 — Option coverage (I-12)**
*For every field* in `RenderOptions`, at least one test proves the field changes
the output. A field with no observable effect MUST be removed from the contract
or implemented.

---

## 16. Definition of Done

1. Every operation in §5.1 exists, is async, and accepts cancellation (R7, R8).
2. All six ports in §6 are interfaces with a working implementation and a test
   fake, and the fakes implement the recording assertions in T-02.
3. The HTTP surface in §7 is implemented with tenant scoping on every route.
4. The pinned renderer container starts in CI and startup asserts the image tag
   (G1).
5. Every invariant in §12 has an executable test; every test in §15 passes.
6. Every error code in §13 is reachable by at least one test.
7. The template language satisfies L1–L7, and the dialect-parity suite (T-17)
   runs in CI.
8. Every limit in §11 is enforced from configuration (P1).
9. No storage path, asset root, tenant, or document type is hard-coded.
10. A README documents: the renderer pinning policy, schema-versioning policy,
    formatting/`formatHint` semantics, the supported Liquid subset, and every
    deviation from this document with its justification.
11. A throwaway editor (textarea + palette + iframe) works against the API in
    under a day (M8).
12. `validate`, `compile`, and `render` are all exercised over HTTP in CI, not
    only in unit tests.

---

## 17. Edge Cases and Expected Behaviour

| Scenario | Expected behaviour |
|---|---|
| Template references an asset that does not exist | `ASSET_MISSING` with the path; no PDF produced |
| Asset path is `../../secrets.txt` | `ASSET_REJECTED`; nothing read |
| Template references `http://169.254.169.254/…` | Render fails (`ASSET_REJECTED`/`RENDER_FAILED`); no egress |
| Collection is empty | Loop renders zero rows; page count reflects it; no error |
| Collection has one row | Renders one row; no off-by-one in footer numbering |
| Optional field is `null` | Renders as empty; `{% if field %}` works |
| Optional field is absent entirely | Same as `null` (binder inserts `null`) |
| Required field absent | `REQUIRED_PLACEHOLDER_MISSING`; render refused |
| Extra key in `data` | `UNKNOWN_DATA_KEY`; render refused |
| Token spelled `invoiceDate` vs `issuedOn` | `UNKNOWN_TOKEN` + suggestion; never silently blank |
| Template contains `{{ items.description }}` outside a loop | `TYPE_MISMATCH`/`UNKNOWN_TOKEN` explaining it needs the loop variable |
| Two `{% for %}` loops use the same `loopVariable` | `SCHEMA_INVALID` at registration |
| Date value already formatted with the wrong hint | Binder is authoritative; the template receives the binder's string |
| Two renders of the same version at different times | Compiled HTML identical; PDF metadata differs (expected) |
| Tenant has no published template, global default exists | Global default is used (T3) |
| Tenant has a draft only, global default exists | Error `TEMPLATE_NOT_PUBLISHED` — do **not** fall through (T3) |
| Renderer returns HTML instead of a PDF | `RENDER_FAILED`; bytes discarded |
| Renderer returns a 0-byte PDF | `RENDER_FAILED`; never returned as success (A4) |
| Client disconnects mid-render | Cancellation propagates; renderer request aborted; no artifact written (P4) |
| Save called twice with the same content | Two versions (versions are intentional); `checksum` identical |
| Concurrent `saveNextVersion` | Unique index on `(tenant, documentType, version)`; one retries or fails cleanly |
| `setDefault` racing with `publish` | Transactional; exactly one default survives (T2) |
| Template > 2 MiB | `TEMPLATE_TOO_LARGE` before parsing |
| 60 000 collection rows | `PAGINATION_LIMIT_EXCEEDED` with guidance to split |
| Header/footer supplied with zero margins | Content clipped (G11); document that this is expected |
| `preferCssPageSize: false` with no paper size | Defaults A4; documented |
| Unknown top-level request field | `REQUEST_INVALID` — never ignored |
| `template` and `inlineTemplate` both present | `REQUEST_INVALID` |
| Production render with `inlineTemplate` | `INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION` |
| Preview attempts to write | `PREVIEW_SIDE_EFFECT_DENIED` (defence in depth) |
| Schema registry empty | `SCHEMA_REGISTRY_EMPTY` at startup, not an empty list at runtime |

---

## 18. Best Practices and Pitfalls

### Do

- **Test compiled HTML, not PDF bytes.** Golden-file the HTML; assert page count
  and extracted text on the PDF.
- **Keep one sample template per construct** in the parity fixture corpus
  (§8.6). It is your regression net.
- **Make the renderer fake deterministic** — return fixed bytes plus a stub page
  count — so unit tests are fast and offline.
- **Log the provenance tuple** (tenant, documentType, templateId, version,
  schemaVersion, inputHash, rendererImage) on every production render. This is
  what makes support tickets answerable.
- **Validate at startup**, not first use: schemas, renderer health, pinned image
  tag, asset root existence.
- **Convert units once**, in one place, with a test that prints a ruler.

### Don't

| Pitfall | Why it bites | Requirement |
|---|---|---|
| Formatting values inside templates | Locale-dependent output; providers disagree | R4, B2, L5, T-19 |
| Reading the wall clock inside the engine | Kills golden tests and reproducibility | I-9 |
| Auto-creating a default template on first read | Hides missing configuration; surprises tenants | T3 |
| Falling back to a global template when a tenant has drafts | Serves another tenant's branding | T3, I-7 |
| Base64-inlining all assets | 33% inflation, slow fonts, preview divergence | G7 |
| Page numbering in `@page` | Chromium support is version-dependent | G10, T-12 |
| Engine margins overriding `@page` | Silent geometry changes | G4, T-10 |
| Accepting options and never forwarding them | Output does not match the contract | I-12, T-20 |
| Using the host view engine because it is familiar | RCE risk, CSS collisions, poor diagnostics | L1, L2 |
| Mixing two template dialects (browser vs server) | Editor accepts what renderer rejects | L7, T-17 |
| Unpinned renderer image | Silent behaviour change on redeploy | G1 |
| Deleting the renderer port "because there is one renderer" | Loses the test fake, timeout home, and failure seam | ADR-10, PR5 |
| Returning an empty PDF on renderer failure | Ships a corrupt document to a customer | I-14, A4 |
| Silent empty substitution for unknown tokens | Blank fields reach customers | V3, I-6 |
| Rendering with inline content in production | Skipping the save step feels faster | Unauditable output; no version to reproduce | R5, H3, S-5 |

---

## Appendix A — Full Worked Example

### A.1 Schema registration (pseudo-code)

```
register(
  documentType: "invoice",
  schemaVersion: 4,
  placeholders: [
    { path: "invoiceNumber", displayLabel: "Invoice number", group: "Header",
      dataType: "string", isRequired: true, sampleValue: "INV-0000" },
    { path: "issuedOn", displayLabel: "Issue date", group: "Header",
      dataType: "date", isRequired: true, formatHint: "yyyy-MM-dd",
      sampleValue: "2026-01-31" },
    { path: "notes", displayLabel: "Notes", group: "Footer",
      dataType: "string", isRequired: false, sampleValue: null },
    { path: "items", displayLabel: "Line items", group: "Lines",
      dataType: "collection", isRequired: false, loopVariable: "item",
      children: [
        { path: "items[].description", displayLabel: "Description",
          dataType: "string", isRequired: true, sampleValue: "EXAMPLE ITEM" },
        { path: "items[].lineTotal", displayLabel: "Line total",
          dataType: "money", isRequired: true, formatHint: "0.00",
          sampleValue: "1,000.00" }
      ] }
  ],
  sampleData: {
    invoiceNumber: "INV-0000", issuedOn: "2026-01-31", notes: null,
    items: [
      { description: "EXAMPLE ITEM ONE", lineTotal: "1,000.00" },
      { description: "EXAMPLE ITEM TWO", lineTotal: "250.50" }
    ]
  }
)
```

### A.2 Raw data from the caller

```json
{
  "invoiceNumber": "INV-2026-00417",
  "issuedOn": "2026-03-14",
  "notes": "Payable within 30 days.",
  "items": [
    { "description": "Consulting services", "lineTotal": "1,250.00" },
    { "description": "Travel reimbursement", "lineTotal": "310.40" }
  ]
}
```

### A.3 Bound model (what the template sees)

```json
{
  "invoiceNumber": "INV-2026-00417",
  "issuedOn": "2026-03-14",
  "notes": "Payable within 30 days.",
  "items": [
    { "description": "Consulting services", "lineTotal": "1,250.00" },
    { "description": "Travel reimbursement", "lineTotal": "310.40" }
  ],
  "generatedAt": "2026-03-14 08:00",
  "documentType": "invoice"
}
```

Note `generatedAt` is injected and pre-formatted. Note nothing was computed — no
subtotal, no tax. If the document needs a total, the caller sends it as another
placeholder (`total`), already computed and formatted.

### A.4 Compile output (excerpt)

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 0; }
      @font-face { font-family: "Inter"; src: url("./assets/Inter.woff2") format("woff2"); }
      body { font-family: "Inter", sans-serif; padding: 18mm 16mm; margin: 0; font-size: 10pt; }
      /* … */
    </style>
  </head>
  <body>
    <h1>Invoice</h1>
    <p class="meta">Invoice INV-2026-00417 &middot; issued 2026-03-14</p>
    <table>
      <thead><tr><th>Description</th><th class="amount">Total</th></tr></thead>
      <tbody>
        <tr><td>Consulting services</td><td class="amount">1,250.00</td></tr>
        <tr><td>Travel reimbursement</td><td class="amount">310.40</td></tr>
      </tbody>
    </table>
    <p class="footer-note">Payable within 30 days.</p>
  </body>
</html>
```

Observe: no Liquid remains; the loop was expanded; the conditional was resolved;
CSS is untouched; the asset reference is unchanged and resolvable from the bundle.

### A.5 Renderer request (conceptual)

```
POST /forms/chromium/convert/html

files: index.html                     ← A.4
files: assets/Inter.woff2             ← from the asset bundle
files: footer.html                    ← compiled footer template
preferCssPageSize: true
printBackground: true
marginBottom: 12                      ← room for the footer (mm→renderer unit)
failOnHttpStatusCodes: [499,500,501,502,503,504]
metadata: {"title":"Invoice INV-2026-00417"}
```

### A.6 Response

```
HTTP 200 OK
content-type: application/pdf
x-template-version: 3
x-schema-version: 4
x-renderer-image: 8.24.1
x-input-hash: sha256:41ab…
x-page-count: 2

<binary PDF>
```

---

## Appendix B — Objective Code Review Checklist

Use this when reviewing the delivered implementation. Every line maps to a
requirement.

**Contract**
- [ ] No operation exposes builder-style optional state; requests are plain value
      objects (ADR-12).
- [ ] `tenant` and `generatedAt` are required on every render path (ADR-7).
- [ ] Unknown request fields are rejected (5.2).
- [ ] `template` + `inlineTemplate` together is rejected (5.13).

**Purity**
- [ ] `compile` has no clock, no randomness, no I/O beyond declared ports (R1).
- [ ] `preview` path cannot reach `OutputStore.save` (I-1, OS1).
- [ ] `preview` attempts to mutate are actively denied, not merely avoided
      (`PREVIEW_SIDE_EFFECT_DENIED`).

**Data**
- [ ] Binder emits only strings/numbers/booleans/arrays/objects (B2).
- [ ] Formatting uses invariant culture; no locale inference (B2, L5).
- [ ] No arithmetic, sorting, filtering, or totals in the binder (B4).
- [ ] `isRequired` enforcement exists and is tested (B3).

**Templates**
- [ ] Published versions cannot be modified (T1).
- [ ] `setDefault` is transactional and clears the previous default (T2).
- [ ] Resolution never silently crosses tenants (T4).
- [ ] `{% include %}`/`{% render %}`/`{% capture %}` are rejected (§8.3).
- [ ] Dialect parity suite exists and runs in CI (L7, T-17).

**Rendering**
- [ ] Image tag pinned and asserted at startup (G1).
- [ ] One renderer implementation; no provider switch (G2).
- [ ] Every option in `RenderOptions` is forwarded; a test proves each has an
      effect (I-12, T-20).
- [ ] Margins/paper units converted explicitly with a test (9.3).
- [ ] Assets sent as files with relative paths (G6).
- [ ] Footer template used for page numbers (G10).
- [ ] No test asserts identical PDF checksums (G12).

**Failure**
- [ ] Every error has a stable code from §13 (E1).
- [ ] No empty/truncated PDF on any failure path (A4, I-14).
- [ ] Retries are bounded and infrastructure-only (G14, E3).
- [ ] No stack traces or internal paths in responses (E5).

**Security**
- [ ] Template language cannot execute host code (S-1).
- [ ] Renderer egress denied by default; local files disabled (S-2).
- [ ] Asset path validation rejects `..`, absolute paths, URLs (S-3, AR2).
- [ ] Size limits enforced before parse (S-8, P1).

**Operations**
- [ ] Health check covers renderer connectivity and image tag (G16).
- [ ] Cancellation aborts the renderer call (P4).
- [ ] Concurrency is bounded per instance (G15).
- [ ] Provenance is logged on every production render (§18).

---

## Appendix C — Glossary

| Term | Definition |
|---|---|
| **Artifact** | A produced file: bytes, name, content type, page count, provenance. |
| **Asset bundle** | The finite set of files a render may reference (fonts, images, CSS). |
| **Binder** | The component that validates raw JSON against the schema and formats values. |
| **Compiled document** | Complete HTML+CSS produced from template + model. Contains no template syntax. |
| **Document type** | A stable key for a kind of document (`invoice`). No business behaviour. |
| **`formatHint`** | Declarative formatting instruction consumed by the binder, never by the template. |
| **Inline template** | Template content submitted directly in a request. Preview/compile/validate only. |
| **Invariant** | A property the product guarantees, with an executable test. |
| **Liquid** | The template language in v1. |
| **Port** | An interface the integrator implements and the engine consumes. |
| **Preview** | A render with no side effects, allowed to use sample data. |
| **Provenance** | The tuple identifying exactly what produced an artifact. |
| **Schema (placeholder schema)** | The declared, versioned list of values a template may use. |
| **Tenant** | Opaque owner of templates and artifacts. Always explicit. |
| **Template** | Immutable, versioned text bound to a tenant and document type. |
| **TemplateRef** | `{ templateId, version }` or the literal `"default"`. |

---

## Appendix D — Reference Stack, Versions, and Local/CI Setup

These are recommendations. Any stack that satisfies the contract is acceptable;
document your choice.

| Concern | Recommendation | Notes |
|---|---|---|
| Language | Any with a mature Liquid implementation | .NET → Fluid; Node → liquidjs; Python → python-liquid; Java → liqp |
| Editor parser | Same language family as the server parser | Parity is easier to keep with the same upstream grammar |
| HTTP | Standard framework routing | Keep handlers thin; all logic behind `DocumentEngine` |
| PDF renderer | `gotenberg/gotenberg:8.x.y` (pinned) | Chromium, multipart HTML conversion |
| Storage | Relational DB for templates/metadata; object store for artifacts | Unique index `(tenant, document_type, version)`; one default per type |
| Tests | Any xUnit-style runner + golden files | Golden files for compiled HTML; snapshot the parity fixtures |
| CI | Docker compose: app + Gotenberg | Renderer started by the harness, health-gated |

### Local setup

```yaml
# docker-compose.yml
services:
  gotenberg:
    image: gotenberg/gotenberg:8.24.1   # pin; never :latest
    ports:
      - "3000:3000"
    # Egress lockdown (S-2). Adapt to your renderer's flag names.
    command:
      - "gotenberg"
      - "--chromium-deny-list=.*"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:3000/health"]
      interval: 5s
      timeout: 3s
      retries: 20
```

```bash
docker compose up -d gotenberg
curl -s http://localhost:3000/health | head -c 400
```

The health response MUST be parsed at startup and the reported image tag compared
against the configured pin (G1). If the tag differs, refuse to start.

### CI outline

1. Start Gotenberg with the pinned tag.
2. Wait for `/health` and assert the tag (G1).
3. Run unit tests with the fake renderer.
4. Run golden-file tests for `compile`.
5. Run the dialect-parity suite (T-17).
6. Run the integration suite (T-01, T-05, T-10, T-11, T-12, T-13, T-14) against
   the real container.
7. Publish the provenance tuple of every render in the job log.

---

## Appendix E — Decisions Deliberately Deferred

Open questions that are **intentionally** not in v1. Do not implement them
silently; they change the contract.

| # | Question | Why deferred | What would change |
|---|---|---|---|
| E-1 | Header/footer template storage | A footer is not a document type. Options: synthetic types (`invoice.footer`) sharing the parent schema, or a separate footer store. | `TemplateStore` keys; `DocumentTypeDescriptor` |
| E-2 | Per-tenant custom placeholders | v1 schemas are registered globally in code. Custom fields would need tenant-scoped schema versioning. | `SchemaRegistry`, `TemplateStore`, validation |
| E-3 | Multi-currency | `money` is a pre-formatted string with no currency identity. | Schema type, binder, potentially filters |
| E-4 | Multi-language documents | Invariant formatting is mandated; there is no per-tenant language. | `displayLabel` localisation, schema duplication, template selection by locale |
| E-5 | Artifact retention / lifecycle | `OutputStore` is a port with no policy. | `OutputStore` interface, ops procedures |
| E-6 | Structured/block templates | A different product: templates as declarative JSON rather than text. Breaks diffability and checksums (T1, T6). | Everything from §5.5 onward |
| E-7 | PDF/A archival output | Requires a post-processing stage; not a property of `render`. | New pipeline step, new provenance fields |
| E-8 | Template preview with real data | Calls business data; conflicts with purity unless gated. | New endpoint with an explicit data-supply contract |

If you need any of these, raise it before building. The engine's value comes
largely from what it refuses to do.
