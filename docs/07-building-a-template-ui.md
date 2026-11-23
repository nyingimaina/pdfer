# Building a template UI

The engine exists so that people who are not programmers can change documents.
That only pays off if the editor is real: a palette, immediate feedback, a
preview, and a safe publish step. This page describes what such an editor needs
from the API and how it should behave. It deliberately stops at the contract —
the implementation is yours.

## Who may do what

Separate three capabilities, because most organisations grant them differently:

| Capability | Typical holder |
|---|---|
| **Preview** a template | anyone who may see documents |
| **Save a draft** | staff who maintain branding |
| **Publish** | a smaller group, or an approval step |

The engine has no user model; your application enforces this. Internally the
distinction maps to `mode: "preview"` versus a published version: drafts are
invisible to production renders, so an unfinished design can never reach a
customer.

## The palette

`GET /document-types/{type}/placeholders` returns a tree with `displayLabel`,
`dataType`, `isRequired`, `group` and, for collections, `loopVariable` and
children. Render it grouped, searchable, and with the type visible — an author
needs to know that `lineTotal` is already formatted money, not a number to
compute with.

Two rules make the palette trustworthy:

- collection members appear **only** inside their loop's context, or are
  inserted as a loop skeleton;
- reserved entries (`generatedAt`, `documentType`, `title`) are visibly
  different from business fields.

## The validation loop

Call `POST /validate` while the author types, debounced. The report is designed
for an editor, not a log file:

- `syntaxErrors` and `unknownTokens` carry **line and column**; underline them;
- `unknownTokens` often carries a `suggestion` — offer it as a one-click fix;
- `missingAssets` names the path, so a broken logo is caught before publishing;
- `warnings` (hardcoded page numbers, header/footer margins) are advisory and do
  not block;
- `unusedPlaceholders` is a hint for cleanup, never an error.

Treat `isRenderable` as the publish gate. **Do not reimplement validation in the
browser.** The server is authoritative; a client-side approximation will drift
and let through exactly the template that fails in production. A browser parser
may exist for highlighting, but its verdict must not be the one that matters.

## Preview

`POST /preview` with the current draft and `useSampleData: true` returns a PDF
with no side effects: no artifact, no counter, no version. That is what makes
preview-on-demand safe, and why it needs no real customer data.

Present it inline and keep it honest:

- show the sample data being used, or a clear "sample document" banner;
- make it obvious that page numbers in a standalone footer preview are empty —
  they only exist in a real render;
- offer "open in a new tab" as a fallback; some browsers refuse PDFs in frames.

## Draft, publish, history

Saving creates a version; publishing makes one live. Design the flow so that:

- **save is cheap and frequent**; authors should not fear it;
- **publish is explicit** and shows which version will become live;
- **history is visible** — version, who saved it, when, and a checksum or diff;
- **rollback is a publish of an older version**, not an edit;
- **concurrent edits are caught**: send `baseVersion` and surface
  `VERSION_CONFLICT` as "someone else changed this" with a reload action.

Never edit a published version. The engine refuses it; your UI should not offer
it.

## Reset and templates per tenant

Keep a "restore the default design" action — it is the escape hatch after a bad
customisation, and it is a new version, so the old design stays in history.
If several documents share a house style, decide whether a change applies to one
document type or all of them, and make that explicit in the UI.

## Assets

Offer upload, list, delete and copy-path. Show which assets the current template
actually references (`in use` / `unused`), because an unused file is either a
forgotten logo or a typo in a path.

Communicate the constraints up front: allowed types, maximum size, and that the
path is relative (`./assets/logo.png`). When an upload replaces a logo, tell the
author that every template using that path changes at once.

## Failure behaviour

The editor is the place where an engine outage is least harmful — nobody is
waiting for a customer document. Use that:

- if validation or preview fails, keep the draft in the browser; never lose
  typed work;
- distinguish "your template is wrong" (a report) from "the engine is
  unavailable" (retry; show a status, not an error dialog);
- disable publish when the last validation said not renderable, but do not
  silently block saving a draft.

## What not to build

- **A drag-and-drop page designer** is a different product: it stops templates
  being diffable text and usually ends up unable to express what CSS already
  does. A code editor with a palette and a preview covers far more ground.
- **Server-side rendering of the editor preview** in your own stack guarantees
  drift from the engine's output. Preview with the engine or not at all.
- **Storing the template in your application database** duplicates the version
  history the engine already keeps and creates two sources of truth.
