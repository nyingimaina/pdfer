# What PDfEr is

PDfEr takes two inputs — a **template** (HTML with a small template language)
and **data** (a JSON object) — and produces a **PDF**.

That is the whole product. Everything else exists to make that promise safe,
repeatable and usable by people who are not programmers.

## The problem it replaces

Most systems start by building documents in code: strings concatenated, or a PDF
library called field by field. That works until:

- a customer wants their logo, wording or columns changed → a developer edits
  code and redeploys;
- a business user wants to change one word → the same;
- a field is missing on some records → the PDF shows a blank and nobody notices
  until a customer complains;
- someone wants to see the layout → the only way is to generate a real document,
  which touches counters and audit rows;
- two environments produce different PDFs → nobody knows why.

PDfEr moves all of that into **versioned, validated, previewable templates**,
behind a contract that makes failures loud.

## The pipeline

```
template + data
      │
      ▼
   COMPILE      pure: placeholders replaced, loops expanded, conditionals
      │         resolved. No clock, no database, no side effects.
      ▼
 complete HTML  a real, standalone web page — open it in a browser and print it
      │
      ▼
   RENDER       headless Chromium, reached over HTTP
      │
      ▼
     PDF        plus provenance: which template version, which schema
                version, which renderer, which input hash
```

## What it owns — and what it refuses to own

It owns:

- resolving which template to use, and which version;
- turning template + data into HTML, and validating that first;
- describing the placeholders a template may use;
- asking a renderer for bytes and checking that a real PDF came back;
- storing template versions and generated artifacts (through storage you configure).

It deliberately does **not** own:

- business concepts, rules or wording — no invoices, customers or stock exist
  in the engine, only words in a JSON payload;
- totals, tax, filtering or sorting — the caller computes, the template places;
- numbering, counters or sequences;
- users, roles or permissions beyond “which tenant owns this”;
- delivery (email, printing, retention policy).

The last list is the point. An engine that starts computing totals becomes a
second business system that has to be kept in step with the first.

## Three rules everything follows

1. **Compiling is pure.** Same template + data + `generatedAt` ⇒ byte-identical
   HTML. Preview is free and cannot corrupt anything.
2. **Templates place values; they do not compute them.** Dates and money are
   formatted once, by the engine, from explicit hints — never by the host's
   locale.
3. **Failures are loud and coded.** Every error has a stable code, and an empty
   or truncated PDF is never returned as success.

Next: [Quick start](02-quick-start.md).
