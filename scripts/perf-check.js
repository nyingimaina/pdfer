'use strict';

/**
 * Volume check (SPEC T-30 / RP4). Runs against a live container:
 *
 *   docker cp scripts/perf-check.js <container>:/tmp/perf.js
 *   docker exec <container> node /tmp/perf.js 10000
 */

const rows = Number(process.argv[2] || 10000);
const base = process.env.BASE || 'http://127.0.0.1:8080';
const tenant = process.env.TENANT || 'demo';

const template = `<!doctype html><html><head><meta charset="utf-8">
<style>@page{size:A4;margin:12mm}body{font:8pt sans-serif;margin:0}
table{width:100%;border-collapse:collapse}td{border-bottom:.2mm solid #ddd;padding:1mm 0}</style>
</head><body><h1>Volume test {{ invoiceNumber }}</h1>
<table><tbody>{% for item in items %}<tr><td>{{ item.description }}</td><td>{{ item.quantity }}</td><td>{{ item.lineTotal }}</td></tr>{% endfor %}</tbody></table>
</body></html>`;

const items = Array.from({ length: rows }, (_, index) => ({
  description: `Row ${index + 1} — example line item`,
  quantity: 1,
  unitPrice: 100,
  lineTotal: 100
}));

const payload = {
  tenant,
  documentType: 'invoice',
  mode: 'preview',
  inlineTemplate: { syntaxId: 'liquid', content: template },
  generatedAt: new Date().toISOString(),
  data: {
    invoiceNumber: `INV-${rows}`,
    issuedOn: '2026-01-31',
    customerName: 'EXAMPLE CUSTOMER',
    items,
    total: rows * 100
  }
};

(async () => {
  const started = Date.now();
  const response = await fetch(`${base}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const elapsed = Date.now() - started;
  if (!response.ok) {
    const text = await response.text();
    process.stdout.write(`FAILED ${response.status} in ${elapsed}ms: ${text.slice(0, 400)}\n`);
    process.exit(1);
  }
  const bytes = (await response.arrayBuffer()).byteLength;
  process.stdout.write(
    JSON.stringify({
      rows,
      pages: response.headers.get('x-page-count'),
      ms: elapsed,
      bytes
    }) + '\n'
  );
})();
