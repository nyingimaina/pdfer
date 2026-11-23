# Quick start

## Run it

```bash
docker run -d --name pdfer -p 8080:8080 -v pdfer-data:/data nyingi/pdfer:1.1.0
```

```bash
curl -s http://localhost:8080/healthz
curl -s http://localhost:8080/readyz
```

`/healthz` means the process is alive. `/readyz` means the embedded Chromium is
reachable too — that is the one that matters before you send traffic.

On first boot the engine seeds a `demo` tenant: an invoice schema, a published
template, a footer and a font bundle. It then renders a self-test page, so a
container that answers `/readyz` has already produced a real PDF.

## Render a PDF

```bash
curl -s -X POST http://localhost:8080/render \
  -H 'content-type: application/json' \
  -d '{
    "tenant": "demo",
    "documentType": "invoice",
    "mode": "production",
    "template": "default",
    "generatedAt": "2026-01-31T09:00:00Z",
    "options": { "footerTemplateRef": "default" },
    "data": {
      "invoiceNumber": "INV-0000",
      "issuedOn": "2026-01-31",
      "customerName": "EXAMPLE CUSTOMER",
      "items": [
        { "description": "EXAMPLE ITEM", "quantity": 2, "unitPrice": 500, "lineTotal": 1000 }
      ],
      "total": 1000
    }
  }' --output invoice.pdf
```

That is the complete loop. Open the PDF; the footer reads `Page 1 of 1`.

## Look at what you sent

The same JSON produces a web page before it produces a PDF:

```bash
curl -s -X POST http://localhost:8080/compile \
  -H 'content-type: application/json' \
  -d '{ ...same body, without "mode"... }' > invoice.html
```

Open `invoice.html` in a browser and print it — same layout, no engine involved.
If a layout looks wrong, this is where to debug it.

## Explore the demo

```bash
# what document types exist
curl -s 'http://localhost:8080/document-types?tenant=demo'

# the field palette a UI would show
curl -s 'http://localhost:8080/document-types/invoice/placeholders'

# a payload that satisfies the schema
curl -s 'http://localhost:8080/document-types/invoice/sample-data'

# the template source
curl -s 'http://localhost:8080/templates?tenant=demo&documentType=invoice'
```

## Preview without touching anything

```bash
curl -s -X POST http://localhost:8080/preview \
  -H 'content-type: application/json' \
  -d '{
    "tenant": "demo",
    "documentType": "invoice",
    "inlineTemplate": { "syntaxId": "liquid", "content": "<h1>{{ customerName }}</h1>" },
    "useSampleData": true,
    "generatedAt": "2026-01-31T09:00:00Z"
  }' --output preview.pdf
```

Preview writes nothing, needs no real data and cannot advance a counter.

## Where to go next

- Make it yours: [Schemas](05-schemas.md) and [Templates](04-templates.md).
- Put it behind your service: [API](06-api.md).
- Let users edit templates: [Building a template UI](07-building-a-template-ui.md).
