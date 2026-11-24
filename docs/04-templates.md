# Templates

A template is a complete HTML document with placeholders. It becomes a PDF after
rendering, and it is already a valid web page before that — which is your
simplest debugging tool.

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { size: A4; margin: 18mm 16mm 22mm; }
      body { font: 10pt "DejaVu Sans", sans-serif; }
    </style>
  </head>
  <body>
    <h1>{{ customerName }}</h1>
    <p>Invoice {{ invoiceNumber }} · {{ issuedOn }}</p>

    <table>
      {% for item in items %}
      <tr>
        <td>{{ item.description }}</td>
        <td>{{ item.lineTotal }}</td>
      </tr>
      {% endfor %}
    </table>
  </body>
</html>
```

## Values are already safe

The engine escapes every `string` value before the template sees it, so
`A & B` arrives as `A &amp; B`. **Do not add `| escape`** to a placeholder — it
would escape twice. A schema can declare a field as `dataType: "html"` for
trusted rich text; that is the only opt-out.

## The language

A deliberately small Liquid subset. Anything else is a validation error with a
line and column, never a silent no-op.

**Tags**

- `{% for item in items %} … {% endfor %}` — with `forloop.index`,
  `forloop.index0`, `forloop.first`, `forloop.last`, `forloop.length`
- `{% if cond %} … {% elsif cond %} … {% else %} … {% endif %}`
- `{% unless cond %} … {% endunless %}`
- `{% assign name = expression %}`
- `{% raw %} … {% endraw %}` — literal `{{` and `{%`
- `{% comment %} … {% endcomment %}`

**Comparisons**: `==`, `!=`, `<`, `>`, `<=`, `>=`, `and`, `or`, `contains`.

**Filters** (presentation only): `escape`, `escape_once`, `default`, `upcase`,
`downcase`, `capitalize`, `strip`, `strip_newlines`, `newline_to_br`, `join`,
`size`, `first`, `last`, `truncate`, `append`, `prepend`, `replace`.

Rejected: `include`, `render`, `capture`, `case`, `cycle`, `increment`,
`decrement`, `tablerow`, `echo`, and every custom filter.

**Whitespace control** works: `{{- value -}}`, `{%- for … -%}`.

## Values, not computations

These are errors by design:

```liquid
{{ issuedOn | date: "%d/%m/%Y" }}     ❌ formatting belongs to the binder
{{ lineTotal | times: 1.14 }}         ❌ no arithmetic
{{ name | downcase | replace: " ", "-" }} ❌ transformation
```

Correct:

```liquid
{{ issuedOn }}     ✅ already "2026-03-14"
{{ lineTotal }}    ✅ already "1,250.00"
```

Case and whitespace filters are allowed because they cannot change a value's
meaning.

## Collections

A collection is iterated with its declared loop variable:

```liquid
{% for item in items %}
  <td>{{ item.description }}</td>
  <td>{{ item.unitPrice }}</td>
  <td>{{ item.lineTotal }}</td>
{% endfor %}
```

`item.description` is only valid **inside** that loop. Outside it, validation
says so and tells you which loop to use. Empty collections render zero rows.

## CSS is untouched

`@page`, `@media`, `@font-face`, `@import` and inline `style` pass through
byte-for-byte. Print geometry belongs in the template:

```css
@page { size: A4; margin: 18mm 16mm 22mm; }
```

`preferCssPageSize` is on by default, so `@page` owns page size and margins.

## Headers and footers

A footer is a separate template (its own document type) rendered by Chromium:

```html
<div style="width:100%; font-size:8pt; color:#888;">
  Invoice {{ invoiceNumber }} — page
  <span class="pageNumber"></span> of <span class="totalPages"></span>
</div>
```

`pageNumber`, `totalPages` and `title` are **reserved CSS class names**, not
Liquid tokens. Do not wrap them in `{{ }}`. Page numbering in the main
template's `@page` is not portable; validation warns about it.

## Assets

Fonts and images travel as files, referenced by relative path:

```css
@font-face { font-family: "Inter"; src: url("./assets/Inter.woff2") format("woff2"); }
```

```html
<img src="./assets/logo.png" style="width: 45mm; height: auto;" />
```

Placement and size are plain CSS: `position: absolute; top: 0; right: 0;
width: 60mm;`, `object-fit`, `opacity`, `z-index`, `transform` all work.
A referenced file that is not in the tenant's asset library is reported by
validation as `ASSET_MISSING` and refuses to publish.

The reference forms are `src`, `href`, `url()` (quoted or bare) and `@import`.
`srcset` and `poster` are not read, so their targets are neither validated nor
bundled — use `src` instead.

The engine uploads every asset to the renderer under a flat, content-derived
name and rewrites these references in the copy it renders. That is invisible in
the output: the compiled HTML, `/compile` and the input hash keep the portable
`./assets/...` form. If a reference the validator could not see still points at
a missing file, the render fails with `RENDER_RESOURCE_FAILED` rather than
producing a PDF without it.

## What gets rejected

Validation rejects, with a location:

- `<script>`, `<iframe>`, `<object>`, `<embed>`, `<base>`, `<form>`;
- `on*=` event attributes, `javascript:`/`vbscript:` URLs, `srcdoc`;
- absolute or remote `src`/`href`/`url()`/`@import` (no egress, by design);
- unknown tokens, unknown tags, unknown filters, unclosed sections;
- bracket access (`items[0]`) — declare paths in the schema instead.

See [Security](09-security.md) for why.
