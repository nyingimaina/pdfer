# Concepts

Six words carry most of the design. Learn these and the rest is detail.

## Tenant

An opaque owner of templates, versions and assets. `acme`, `co-3f2504e0…`, a
customer id. Every operation names one explicitly; nothing is inferred from a
header, a session or a hostname.

Tenants are the isolation boundary. A template id from another tenant is
`TEMPLATE_NOT_FOUND`, never a fallback.

## Document type

A stable key for a kind of document: `invoice`, `statement`, `receipt`. It has a
placeholder schema and one or more templates. It contains no business logic.

Useful pattern: a document type's header and footer are *separate* document
types, e.g. `invoice-footer`, sharing the parent schema.

## Placeholder schema

The declared, versioned list of values a template may use: name, label, type,
formatting hint, whether it is a collection and, for collections, what its
member fields are.

The schema is a **contract**, not a reflection of your objects. Registering a new
field means bumping its version. A UI can render the schema as a field palette,
and validation can tell an author that `invoiceDate` does not exist and they
probably meant `issuedOn`.

Schemas live in a manifest file you mount:

```json
{ "schemas": [ { "documentType": "invoice", "schemaVersion": 1, "root": [ … ] } ] }
```

See [Schemas](05-schemas.md).

## Template and version

Templates are text (HTML + Liquid), owned by a tenant and a document type.
Saving always creates a new **version**; published versions never change. A
template reference is either an explicit `{ templateId, version }` or the literal
`"default"`, meaning the tenant's published default.

State machine:

```
save → draft → publish → published → retire → retired
```

A production render must reference a published version. Preview may use a draft
or inline content.

## Bind, compile, render

Three distinct steps, and the distinction prevents most integration bugs.

| Step | Input | Output | Rules |
|---|---|---|---|
| **Bind** | raw JSON + schema | a model of strings, numbers, booleans, arrays, objects | strict: unknown keys and missing required values fail |
| **Compile** | template + model | complete HTML | pure: no clock, no disk, no network |
| **Render** | HTML + assets + options | PDF bytes + page count | isolated, timed, bounded |

The binder is where formatting happens:

| Type | Input | Hint | Output |
|---|---|---|---|
| `money` | number `1250` | `#,##0.00` | `1,250.00` |
| `date` | `2026-03-14` | `yyyy-MM-dd` | `2026-03-14` |
| `string` | `"A & B"` | — | `A &amp; B` (escaped by default) |

If a template could format a date, output would depend on the renderer's locale
and two environments would disagree. So it cannot.

## Artifact and provenance

A render returns bytes plus facts about how they were made:

```json
{
  "templateId": "tpl_…", "templateVersion": 3,
  "schemaVersion": 4, "syntaxId": "liquid",
  "rendererImage": "8.40.0",
  "inputHash": "sha256:…", "dataHash": "sha256:…"
}
```

`inputHash` covers compiled HTML + asset checksums + render options. `dataHash`
covers the bound model. Re-rendering the same inputs reproduces the compiled HTML
exactly; PDF bytes differ only because Chromium stamps metadata.

## Modes

| Mode | Template | Writes | Use |
|---|---|---|---|
| `production` | must resolve to a **published** version | stores the artifact | real documents |
| `preview` | published, draft or inline | nothing | editor preview, tests |

Preview is what makes a real template editor possible: an author can render on
every save without generating a customer-facing record or moving a counter.

Next: [Templates](04-templates.md) or [Schemas](05-schemas.md).
