'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { createLogger } = require('../src/logger');
const { createRuntime } = require('../src/server');

const FAKE_PDF = Buffer.from('%PDF-1.4\n% fake renderer output\n%%EOF\n', 'latin1');

class FakeRenderer {
  constructor({ pageCount = 2, fail = null } = {}) {
    this.calls = [];
    this.pageCount = pageCount;
    this.fail = fail;
    this.healthy = true;
  }

  async render(request) {
    this.calls.push(request);
    if (this.fail) throw this.fail;
    return { bytes: FAKE_PDF, pageCount: this.pageCount };
  }

  async health() {
    return { ok: this.healthy, status: this.healthy ? 'up' : 'down', version: '8.24.1' };
  }
}

async function makeRuntime(overrides = {}) {
  const dataDir = overrides.dataDir || (await fs.mkdtemp(path.join(os.tmpdir(), 'pdfer-test-')));
  const config = {
    ...loadConfig({}),
    dataDir,
    seedDemo: false,
    authMode: 'off',
    logLevel: 'silent',
    ...(overrides.config || {})
  };
  const logger = createLogger('silent');
  const runtime = await createRuntime({
    config,
    logger,
    renderer: overrides.renderer || new FakeRenderer(),
    clock: overrides.clock
  });
  await runtime.engine.init();
  return { ...runtime, dataDir, logger };
}

async function cleanup(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const SAMPLE_DATA = {
  invoiceNumber: 'INV-2026-00417',
  issuedOn: '2026-03-14',
  dueOn: '2026-03-28',
  customerName: 'EXAMPLE CUSTOMER',
  customerAddress: '1 EXAMPLE STREET',
  items: [
    { description: 'Consulting', quantity: 1, unitPrice: 1000, lineTotal: 1000 }
  ],
  total: 1000,
  notes: 'Payable within 30 days.'
};

const TEMPLATE = `<!doctype html>
<html><head><meta charset="utf-8"><style>@page { size: A4; margin: 20mm; }</style></head>
<body>
<h1>{{ title }}</h1>
<p>{{ invoiceNumber }} — {{ issuedOn }}</p>
<p>{{ customerName }}</p>
<table>{% for item in items %}<tr><td>{{ item.description }}</td><td>{{ item.lineTotal }}</td></tr>{% endfor %}</table>
<p>{{ total }}</p>
{% if notes %}<p>{{ notes }}</p>{% endif %}
</body></html>`;

async function createPublishedTemplate(runtime, { tenant = 'demo', content = TEMPLATE, documentType = 'invoice' } = {}) {
  const saved = await runtime.engine.saveTemplate({
    tenant,
    documentType,
    content,
    displayLabel: 'Test template'
  });
  await runtime.templateStore.publish(
    { templateId: saved.templateId, version: saved.version },
    tenant
  );
  await runtime.templateStore.setDefault(
    { templateId: saved.templateId, version: saved.version },
    tenant
  );
  return saved;
}

module.exports = {
  FakeRenderer,
  FAKE_PDF,
  makeRuntime,
  cleanup,
  SAMPLE_DATA,
  TEMPLATE,
  createPublishedTemplate
};
