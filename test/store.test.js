'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRuntime, cleanup, TEMPLATE } = require('./helpers');

test('save creates immutable versions and publishes exactly one default', async () => {
  const runtime = await makeRuntime();
  try {
    const { engine, templateStore } = runtime;

    const v1 = await engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: TEMPLATE,
      displayLabel: 'v1'
    });
    assert.equal(v1.version, 1);
    await engine.publishTemplate({ templateId: v1.templateId, version: 1 }, 'demo');
    await engine.setDefaultTemplate({ templateId: v1.templateId, version: 1 }, 'demo');

    const v2 = await engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: TEMPLATE.replace('{{ title }}', '{{ title }} v2'),
      displayLabel: 'v2',
      sourceTemplateId: v1.templateId,
      baseVersion: 1
    });
    assert.equal(v2.templateId, v1.templateId);
    assert.equal(v2.version, 2);

    const defaultRef = await templateStore.getDefault('demo', 'invoice');
    assert.deepEqual(defaultRef, { templateId: v1.templateId, version: 1 });

    await engine.publishTemplate({ templateId: v1.templateId, version: 2 }, 'demo');
    const stillV1 = await templateStore.resolve('demo', 'invoice', 'default');
    assert.equal(stillV1.version, 1, 'publishing v2 must not move the default');

    await assert.doesNotReject(() =>
      templateStore.publish({ templateId: v1.templateId, version: 2 }, 'demo')
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('baseVersion mismatch is a conflict, not a lost update', async () => {
  const runtime = await makeRuntime();
  try {
    const { engine } = runtime;
    const v1 = await engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: TEMPLATE
    });
    await engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: TEMPLATE,
      sourceTemplateId: v1.templateId,
      baseVersion: 1
    });
    await assert.rejects(
      () =>
        engine.saveTemplate({
          tenant: 'demo',
          documentType: 'invoice',
          content: TEMPLATE,
          sourceTemplateId: v1.templateId,
          baseVersion: 1
        }),
      (error) => error.code === 'VERSION_CONFLICT'
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('retiring the default clears it and resolution fails loudly', async () => {
  const runtime = await makeRuntime();
  try {
    const { engine, templateStore } = runtime;
    const v1 = await engine.saveTemplate({ tenant: 'demo', documentType: 'invoice', content: TEMPLATE });
    await engine.publishTemplate({ templateId: v1.templateId, version: 1 }, 'demo');
    await engine.setDefaultTemplate({ templateId: v1.templateId, version: 1 }, 'demo');

    await engine.retireTemplate({ templateId: v1.templateId, version: 1 }, 'demo');

    assert.equal(await templateStore.getDefault('demo', 'invoice'), null);
    await assert.rejects(
      () => templateStore.resolve('demo', 'invoice', 'default'),
      (error) => error.code === 'NO_DEFAULT_TEMPLATE'
    );
    await assert.rejects(
      () => engine.publishTemplate({ templateId: v1.templateId, version: 1 }, 'demo'),
      (error) => error.code === 'TEMPLATE_RETIRED'
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('a draft cannot be set as default', async () => {
  const runtime = await makeRuntime();
  try {
    const v1 = await runtime.engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: TEMPLATE
    });
    await assert.rejects(
      () => runtime.engine.setDefaultTemplate({ templateId: v1.templateId, version: 1 }, 'demo'),
      (error) => error.code === 'TEMPLATE_NOT_PUBLISHED'
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('checksums normalise line endings and BOM', async () => {
  const runtime = await makeRuntime();
  try {
    const lf = 'a\r\nb\rc\n';
    const bom = '\uFEFFa\nb\nc\n';
    const first = await runtime.engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: lf
    });
    const second = await runtime.engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: bom
    });
    assert.equal(first.checksum, second.checksum);
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('templates are isolated by tenant', async () => {
  const runtime = await makeRuntime();
  try {
    const { engine } = runtime;
    const v1 = await engine.saveTemplate({ tenant: 'acme', documentType: 'invoice', content: TEMPLATE });
    await assert.rejects(
      () => engine.getTemplate({ templateId: v1.templateId, version: 1 }, 'other'),
      (error) => error.code === 'TEMPLATE_NOT_FOUND'
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('listing is paginated', async () => {
  const runtime = await makeRuntime();
  try {
    const { engine } = runtime;
    const v1 = await engine.saveTemplate({ tenant: 'demo', documentType: 'invoice', content: TEMPLATE });
    for (let version = 2; version <= 5; version++) {
      await engine.saveTemplate({
        tenant: 'demo',
        documentType: 'invoice',
        content: TEMPLATE + `<!-- ${version} -->`,
        sourceTemplateId: v1.templateId
      });
    }
    const first = await engine.listTemplates('demo', { documentType: 'invoice', limit: 2 });
    assert.equal(first.items.length, 2);
    assert.ok(first.nextCursor);
    const second = await engine.listTemplates('demo', {
      documentType: 'invoice',
      limit: 2,
      cursor: first.nextCursor
    });
    assert.equal(second.items.length, 2);
    const ids = new Set([...first.items, ...second.items].map((item) => `${item.templateId}:${item.version}`));
    assert.equal(ids.size, 4);
  } finally {
    await cleanup(runtime.dataDir);
  }
});
