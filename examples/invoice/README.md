# Example: an invoice

A complete, working document type: schema, template, footer, payload, and the
commands that wire them up.

| File | What it is |
|---|---|
| `schema.json` | A schema manifest declaring `example-invoice` and its footer |
| `template.html` | The invoice body |
| `footer.html` | Page numbering and a running line |
| `render-request.json` | A ready-to-send render request |
| `provision.sh` | Creates, publishes and defaults the two templates |

## Run it

```bash
# 1. The engine, with this manifest mounted and the demo seed off
docker run -d --name pdfer -p 8080:8080 -v pdfer-data:/data \
  -v "$PWD/schema.json:/config/schemas.json:ro" \
  -e PDFER_SCHEMAS_FILE=/config/schemas.json \
  -e PDFER_SEED_DEMO=false \
  nyingi/pdfer:1.1.0

# 2. Create and publish the templates
./provision.sh

# 3. Render
curl -s -X POST http://localhost:8080/render \
  -H 'content-type: application/json' \
  --data-binary @render-request.json \
  --output invoice.pdf
```

`render-request.json` uses tenant `demo`; change `tenant` in both the script
argument and the payload to use another.

## What to notice

- The template is a normal HTML page. Print it from a browser and you get the
  same layout.
- `issuedOn`, `quantity`, `unitPrice`, `lineTotal` and `total` are formatted by
  the engine. The template only places them.
- The footer is a **separate document type**; its `pageNumber` / `totalPages`
  spans are filled by Chromium, not by Liquid.
- `provision.sh` is idempotent: it does nothing when a published default already
  exists.
