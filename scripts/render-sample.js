'use strict';

/**
 * Renders the demo invoice and writes the PDF to a file. Useful for eyeballing
 * output without a browser:
 *
 *   docker cp scripts/render-sample.js <container>:/tmp/render.js
 *   docker exec <container> node /tmp/render.js /tmp/invoice.pdf
 *   docker cp <container>:/tmp/invoice.pdf ./invoice.pdf
 */

const fs = require('node:fs');
const path = require('node:path');

const target = process.argv[2] || '/tmp/invoice.pdf';
const base = process.env.BASE || 'http://127.0.0.1:8080';
const tenant = process.env.TENANT || 'demo';
const rows = Number(process.env.ROWS || 45);

const items = Array.from({ length: rows }, (_, index) => ({
  description: `Consulting services ${index + 1}`,
  quantity: 1,
  unitPrice: 100,
  lineTotal: 100
}));

const payload = {
  tenant,
  documentType: 'invoice',
  mode: 'production',
  template: 'default',
  generatedAt: '2026-01-31T09:00:00Z',
  options: { footerTemplateRef: 'default', metadata: { title: 'Invoice INV-0000' } },
  assets: undefined,
  data: {
    invoiceNumber: 'INV-0000',
    issuedOn: '2026-01-31',
    dueOn: '2026-02-28',
    customerName: 'EXAMPLE CUSTOMER',
    customerAddress: '1 EXAMPLE STREET\nEXAMPLE CITY',
    items,
    total: rows * 100,
    notes: 'EXAMPLE NOTE — payable within 30 days.'
  }
};

(async () => {
  const response = await fetch(`${base}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    process.stderr.write(`render failed: ${response.status} ${await response.text()}\n`);
    process.exit(1);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  process.stdout.write(
    `wrote ${target} (${bytes.length} bytes, ${response.headers.get('x-page-count')} pages, ` +
      `template v${response.headers.get('x-template-version')}, renderer ${response.headers.get('x-renderer-image')})\n`
  );
})();
