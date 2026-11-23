# Schemas

A schema is the declared list of values a template may use. It is a contract:
templates are validated against it, UIs render it as a field palette, and the
binder uses it to type and format incoming data.

Schemas are **not** discovered from your objects. Adding a placeholder is a
deliberate version bump.

## The manifest

The image ships only a demo type. Your document types come from a JSON file
mounted read-only and named by `PDFER_SCHEMAS_FILE`:

```bash
docker run -d -p 8080:8080 \
  -v pdfer-data:/data \
  -v "$PWD/schemas.json:/config/schemas.json:ro" \
  -e PDFER_SCHEMAS_FILE=/config/schemas.json \
  -e PDFER_SEED_DEMO=false \
  nyingi/pdfer:1.1.0
```

The file is `{ "schemas": [ … ] }`. An invalid manifest aborts startup with
`SCHEMA_INVALID` — never a first-request surprise.

## A descriptor

```json
{
  "name": "issuedOn",
  "displayLabel": "Issue date",
  "group": "Header",
  "dataType": "date",
  "formatHint": "yyyy-MM-dd",
  "isRequired": true,
  "sampleValue": "2026-01-31"
}
```

| Field | Rule |
|---|---|
| `name` | The token templates use at the root. |
| `displayLabel` | Human wording for the palette. Required. |
| `group` | Optional presentation grouping (`Header`, `Lines`, `Totals`). |
| `dataType` | `string`, `html`, `number`, `money`, `date`, `datetime`, `boolean`, `object`, `collection`. |
| `isRequired` | A render missing this value fails. |
| `formatHint` | Formatting for the binder only. Never seen by the template. |
| `sampleValue` | Used by preview and by the sample-data endpoint. |
| `isCollection` | `true` if and only if `dataType` is `collection`. |
| `loopVariable` | Required for collections; must be unique in the schema. |
| `children` | Required for `collection` and `object`; forbidden otherwise. |

Nesting is capped at four levels of collections/objects — deeper schemas produce
unusable palettes and pathological templates.

## Types and formatting

| Type | Caller sends | Engine emits | Hint example |
|---|---|---|---|
| `string` | string | escaped string | — |
| `html` | string | as-is (trusted) | — |
| `number` | number | formatted string | `0.###` |
| `money` | number | formatted string | `#,##0.00` |
| `date` | ISO date string | formatted string | `yyyy-MM-dd` |
| `datetime` | RFC 3339 UTC | formatted string | `yyyy-MM-dd HH:mm` |
| `boolean` | boolean | boolean | — |
| `collection` | array of objects | array | — |
| `object` | object | object | — |

Numeric hints are .NET-style patterns: `#,##0.00`, `€ #,##0.00`, `0`, `0.##`.
Grouping appears only if `,` is present. Dates use `yyyy yy MM M dd d HH H mm ss`
in UTC. No locale, no time zone, no currency conversion.

`money` and `number` inputs must be **numbers** (or canonical decimal strings);
a pre-formatted `"1,250.00"` is rejected. That is deliberate: formatting twice is
how environments drift.

## Collections

```json
{
  "name": "items",
  "displayLabel": "Line items",
  "dataType": "collection",
  "isCollection": true,
  "loopVariable": "item",
  "isRequired": false,
  "sampleValue": null,
  "children": [
    { "name": "description", "displayLabel": "Description", "dataType": "string", "isRequired": true, "sampleValue": "EXAMPLE ITEM" },
    { "name": "quantity", "displayLabel": "Quantity", "dataType": "number", "formatHint": "0.###", "isRequired": true, "sampleValue": 1 },
    { "name": "unitPrice", "displayLabel": "Unit price", "dataType": "money", "formatHint": "#,##0.00", "isRequired": true, "sampleValue": 100 },
    { "name": "lineTotal", "displayLabel": "Line total", "dataType": "money", "formatHint": "#,##0.00", "isRequired": true, "sampleValue": 100 }
  ]
}
```

Children are addressed as `item.description`. Paths in the palette use `[]`:
`items[].description`.

`object` values are **not iterable**; their children are addressable by declared
path only. For anything you need to loop over, use a collection.

## Reserved names

Three tokens are injected by the engine and cannot be declared:

- `generatedAt` — the caller's `generatedAt`, formatted `yyyy-MM-dd HH:mm` UTC
- `documentType` — the key
- `title` — `options.metadata.title`, else the document type

Loop variables cannot be `forloop`, `for`, `if`, `unless`, `assign`, `raw`,
`comment`, or any `end…` tag.

## Versioning

`schemaVersion` is a positive integer. A change is a new version; old versions
stay resolvable forever, so old templates keep rendering. A template records the
schema version it was authored against, and that is what it renders with.

`GET /document-types/{type}/placeholders?version=3` returns that version.
Omitting `version` returns the latest.

## Sample data

`sampleValue` is the source of the sample payload used by preview. Collections
get two rows so loop layout is visible. A missing required sample is a startup
error.

Next: [API](06-api.md).
