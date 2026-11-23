'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

const DEMO_TENANT = 'demo';

/**
 * Zero-config first boot (SPEC Z-6): seeds a demo tenant only when /data holds
 * no templates. Never overwrites user data.
 */
async function seedDemo({ config, engine, templateStore, assetResolver, logger, seedDir }) {
  const templatesRoot = path.join(config.dataDir, 'templates');
  let existing = [];
  try {
    existing = await fs.readdir(templatesRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing.some((entry) => entry.isDirectory())) {
    logger.debug({ tenant: DEMO_TENANT }, 'seed skipped: data directory is not empty');
    return { seeded: false };
  }

  const fontDir = path.join(seedDir, 'assets');
  let fontFaces = '';
  try {
    const regular = await fs.readFile(path.join(fontDir, 'DejaVuSans.ttf'));
    const bold = await fs.readFile(path.join(fontDir, 'DejaVuSans-Bold.ttf'));
    await assetResolver.register(DEMO_TENANT, {
      path: 'assets/DejaVuSans.ttf',
      bytes: regular,
      mimeType: 'font/ttf'
    });
    await assetResolver.register(DEMO_TENANT, {
      path: 'assets/DejaVuSans-Bold.ttf',
      bytes: bold,
      mimeType: 'font/ttf'
    });
    fontFaces = `
      @font-face { font-family: "PDfEr Sans"; src: url("./assets/DejaVuSans.ttf") format("truetype"); font-weight: 400; }
      @font-face { font-family: "PDfEr Sans"; src: url("./assets/DejaVuSans-Bold.ttf") format("truetype"); font-weight: 600; }`;
  } catch (error) {
    logger.warn({ err: error.message }, 'seed fonts unavailable; using renderer fallback fonts');
  }

  const main = renderMainTemplate(fontFaces);
  const footer = renderFooterTemplate(fontFaces);
  const header = renderHeaderTemplate(fontFaces);

  const saved = await engine.saveTemplate({
    tenant: DEMO_TENANT,
    documentType: 'invoice',
    content: main,
    displayLabel: 'Invoice — demo',
    createdBy: 'seed'
  });
  await templateStore.publish({ templateId: saved.templateId, version: saved.version }, DEMO_TENANT);
  await templateStore.setDefault({ templateId: saved.templateId, version: saved.version }, DEMO_TENANT);

  const savedFooter = await engine.saveTemplate({
    tenant: DEMO_TENANT,
    documentType: 'invoice-footer',
    content: footer,
    displayLabel: 'Invoice footer — demo',
    createdBy: 'seed'
  });
  await templateStore.publish(
    { templateId: savedFooter.templateId, version: savedFooter.version },
    DEMO_TENANT
  );
  await templateStore.setDefault(
    { templateId: savedFooter.templateId, version: savedFooter.version },
    DEMO_TENANT
  );

  const savedHeader = await engine.saveTemplate({
    tenant: DEMO_TENANT,
    documentType: 'invoice-header',
    content: header,
    displayLabel: 'Invoice header — demo',
    createdBy: 'seed'
  });
  await templateStore.publish(
    { templateId: savedHeader.templateId, version: savedHeader.version },
    DEMO_TENANT
  );
  await templateStore.setDefault(
    { templateId: savedHeader.templateId, version: savedHeader.version },
    DEMO_TENANT
  );

  logger.info(
    { tenant: DEMO_TENANT, templateId: saved.templateId, version: saved.version },
    'demo tenant seeded'
  );
  return { seeded: true, tenant: DEMO_TENANT, templateId: saved.templateId };
}

function renderMainTemplate(fontFaces) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>{{ title }}</title>
  <style>${fontFaces}
    @page { size: A4; margin: 18mm 16mm 22mm; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { font-family: "PDfEr Sans", "DejaVu Sans", sans-serif; font-size: 10pt; color: #111827; }
    header { display: flex; justify-content: space-between; align-items: flex-start; gap: 10mm; margin-bottom: 8mm; }
    h1 { font-size: 20pt; margin: 0; letter-spacing: -0.02em; }
    .muted { color: #6b7280; font-size: 9pt; }
    .doc-meta { text-align: right; font-size: 9pt; }
    table { width: 100%; border-collapse: collapse; margin-top: 6mm; }
    thead th { text-align: left; font-size: 8.5pt; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; border-bottom: .4mm solid #d1d5db; padding: 0 0 2mm; }
    td { padding: 2.2mm 0; border-bottom: .2mm solid #e5e7eb; vertical-align: top; }
    .num { text-align: right; }
    thead th.num { text-align: right; }
    .totals { margin-top: 6mm; margin-left: auto; width: 60mm; }
    .totals div { display: flex; justify-content: space-between; padding: 1.5mm 0; }
    .totals .grand { border-top: .4mm solid #111827; font-weight: 600; }
    .notes { margin-top: 8mm; font-size: 8.5pt; color: #374151; white-space: pre-line; }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>{{ title }}</h1>
      <div class="muted">{{ customerName }}</div>
      {% if customerAddress %}<div class="muted" style="white-space: pre-line">{{ customerAddress }}</div>{% endif %}
    </div>
    <div class="doc-meta">
      <div><strong>{{ invoiceNumber }}</strong></div>
      <div class="muted">Issued {{ issuedOn }}</div>
      {% if dueOn %}<div class="muted">Due {{ dueOn }}</div>{% endif %}
    </div>
  </header>

  <table>
    <thead>
      <tr><th>Description</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr>
    </thead>
    <tbody>
      {% for item in items %}
      <tr>
        <td>{{ item.description }}</td>
        <td class="num">{{ item.quantity }}</td>
        <td class="num">{{ item.unitPrice }}</td>
        <td class="num">{{ item.lineTotal }}</td>
      </tr>
      {% endfor %}
    </tbody>
  </table>

  <div class="totals">
    <div class="grand"><span>Total</span><span>{{ total }}</span></div>
  </div>

  {% if notes %}<div class="notes">{{ notes }}</div>{% endif %}
</body>
</html>
`;
}

function renderHeaderTemplate(fontFaces) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>${fontFaces}
    html, body { margin: 0; padding: 0; font-family: "PDfEr Sans", "DejaVu Sans", sans-serif; font-size: 8pt; color: #9ca3af; }
    .header { width: 100%; padding: 0 16mm; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="header">
    <span>{{ title }}</span>
    <span>{{ documentType }}</span>
  </div>
</body>
</html>
`;
}

function renderFooterTemplate(fontFaces) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>${fontFaces}
    html, body { margin: 0; padding: 0; font-family: "PDfEr Sans", "DejaVu Sans", sans-serif; font-size: 8pt; color: #6b7280; }
    .footer { width: 100%; padding: 0 16mm; display: flex; justify-content: space-between; }
  </style>
</head>
<body>
  <div class="footer">
    <span>{{ invoiceNumber }}</span>
    <span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
  </div>
</body>
</html>
`;
}

module.exports = { seedDemo, DEMO_TENANT };
