'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeRuntime,
  cleanup,
  FakeRenderer,
  SAMPLE_DATA,
  TEMPLATE,
  createPublishedTemplate,
  FAKE_PDF
} = require('./helpers');

test('production render returns a PDF with provenance and stores the artifact', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime);
    const { engine } = runtime;

    const { artifact, bytes } = await engine.render({
      tenant: 'demo',
      documentType: 'invoice',
      mode: 'production',
      template: 'default',
      data: SAMPLE_DATA,
      generatedAt: '2026-03-14T08:00:00Z'
    });

    assert.equal(artifact.contentType, 'application/pdf');
    assert.equal(artifact.pageCount, 2);
    assert.equal(bytes.length, FAKE_PDF.length);
    assert.ok(artifact.handle, 'production renders are persisted');
    assert.equal(artifact.provenance.schemaVersion, 1);
    assert.equal(artifact.provenance.templateVersion, 1);
    assert.match(artifact.provenance.inputHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(artifact.provenance.dataHash, /^sha256:[a-f0-9]{64}$/);

    const stored = await runtime.outputStore.read(artifact.handle, 'demo');
    assert.equal(stored.meta.byteLength, bytes.length);
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('preview never persists an artifact', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime);
    const { artifact } = await runtime.engine.preview({
      tenant: 'demo',
      documentType: 'invoice',
      template: 'default',
      generatedAt: '2026-03-14T08:00:00Z',
      useSampleData: true
    });
    assert.equal(artifact.handle, undefined);
    assert.equal(artifact.pageCount, 2);
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('preview refuses to mutate the template store', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime);
    const { engine } = runtime;
    // If the preview path ever touched a mutating method it would throw.
    await assert.doesNotReject(() =>
      engine.preview({
        tenant: 'demo',
        documentType: 'invoice',
        template: 'default',
        data: SAMPLE_DATA,
        generatedAt: '2026-03-14T08:00:00Z'
      })
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('compiled HTML is deterministic and free of template syntax', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime);
    const request = {
      tenant: 'demo',
      documentType: 'invoice',
      inlineTemplate: { syntaxId: 'liquid', content: TEMPLATE },
      data: SAMPLE_DATA,
      generatedAt: '2026-03-14T08:00:00Z'
    };
    const first = await runtime.engine.compile(request);
    const second = await runtime.engine.compile(request);
    assert.equal(first.html, second.html);
    assert.equal(first.provenance.inputHash, second.provenance.inputHash);
    assert.ok(!first.html.includes('{{'));
    assert.ok(!first.html.includes('{%'));
    assert.match(first.html, /INV-2026-00417/);
    assert.match(first.html, /1,000\.00/);
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('inline templates are rejected in production', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime);
    await assert.rejects(
      () =>
        runtime.engine.render({
          tenant: 'demo',
          documentType: 'invoice',
          mode: 'production',
          inlineTemplate: { syntaxId: 'liquid', content: TEMPLATE },
          data: SAMPLE_DATA,
          generatedAt: '2026-03-14T08:00:00Z'
        }),
      (error) => error.code === 'INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION'
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('generatedAt is required and must be UTC', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime);
    for (const generatedAt of [undefined, '2026-03-14T08:00:00+02:00', 'yesterday']) {
      await assert.rejects(
        () =>
          runtime.engine.render({
            tenant: 'demo',
            documentType: 'invoice',
            mode: 'production',
            template: 'default',
            data: SAMPLE_DATA,
            generatedAt
          }),
        (error) => error.code === 'REQUEST_INVALID'
      );
    }
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('unknown data keys are refused before rendering', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime);
    const renderer = runtime.renderer;
    const before = renderer.calls.length;
    await assert.rejects(
      () =>
        runtime.engine.render({
          tenant: 'demo',
          documentType: 'invoice',
          mode: 'production',
          template: 'default',
          data: { ...SAMPLE_DATA, surprise: 1 },
          generatedAt: '2026-03-14T08:00:00Z'
        }),
      (error) => error.code === 'UNKNOWN_DATA_KEY'
    );
    assert.equal(renderer.calls.length, before, 'the renderer must not be called');
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('assets are auto-bundled from the tenant store when omitted', async () => {
  const runtime = await makeRuntime();
  try {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
    await runtime.assetResolver.register('demo', {
      path: 'assets/logo.svg',
      bytes: svg,
      mimeType: 'image/svg+xml'
    });
    await createPublishedTemplate(runtime, {
      content: TEMPLATE.replace('<h1>{{ title }}</h1>', '<img src="./assets/logo.svg" alt=""><h1>{{ title }}</h1>')
    });

    const renderer = new FakeRenderer();
    runtime.engine.renderer = renderer;

    await runtime.engine.render({
      tenant: 'demo',
      documentType: 'invoice',
      mode: 'production',
      template: 'default',
      data: SAMPLE_DATA,
      generatedAt: '2026-03-14T08:00:00Z'
    });

    const bundle = renderer.calls[0].assets;
    assert.equal(bundle.length, 1);
    assert.equal(bundle[0].path, 'assets/logo.svg');
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('a missing asset fails the render', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime, {
      content: TEMPLATE.replace('<h1>{{ title }}</h1>', '<img src="./assets/nope.png"><h1>{{ title }}</h1>')
    });
    await assert.rejects(
      () =>
        runtime.engine.render({
          tenant: 'demo',
          documentType: 'invoice',
          mode: 'production',
          template: 'default',
          data: SAMPLE_DATA,
          generatedAt: '2026-03-14T08:00:00Z'
        }),
      (error) => error.code === 'ASSET_MISSING'
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('unknown tokens fail the render with a location', async () => {
  const runtime = await makeRuntime();
  try {
    await createPublishedTemplate(runtime, {
      content: TEMPLATE.replace('{{ invoiceNumber }}', '{{ invoiceDate }}')
    });
    await assert.rejects(
      () =>
        runtime.engine.render({
          tenant: 'demo',
          documentType: 'invoice',
          mode: 'production',
          template: 'default',
          data: SAMPLE_DATA,
          generatedAt: '2026-03-14T08:00:00Z'
        }),
      (error) => error.code === 'UNKNOWN_TOKEN' && error.location.line > 0
    );
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('validation reports are non-throwing and actionable', async () => {
  const runtime = await makeRuntime();
  try {
    const report = await runtime.engine.validate({
      tenant: 'demo',
      documentType: 'invoice',
      inlineTemplate: {
        syntaxId: 'liquid',
        content: '<p>{{ invoiceDate }}</p>{% for item in items %}{{ item.description }}{% endfor %}'
      }
    });
    assert.equal(report.isRenderable, false);
    assert.equal(report.unknownTokens[0].token, 'invoiceDate');
    assert.ok(Array.isArray(report.unusedPlaceholders));
    assert.equal(report.syntaxVersion, undefined);
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('reserved placeholders are injected', async () => {
  const runtime = await makeRuntime();
  try {
    const result = await runtime.engine.compile({
      tenant: 'demo',
      documentType: 'invoice',
      inlineTemplate: {
        syntaxId: 'liquid',
        content: '{{ documentType }}|{{ generatedAt }}|{{ title }}'
      },
      data: SAMPLE_DATA,
      generatedAt: '2026-03-14T08:00:00Z'
    });
    assert.equal(result.html, 'invoice|2026-03-14 08:00|invoice');
  } finally {
    await cleanup(runtime.dataDir);
  }
});

test('version pinning: rendering v1 after v2 is published is stable', async () => {
  const runtime = await makeRuntime();
  try {
    const v1 = await createPublishedTemplate(runtime);
    const v2 = await runtime.engine.saveTemplate({
      tenant: 'demo',
      documentType: 'invoice',
      content: TEMPLATE.replace('{{ title }}', '{{ title }} (v2)'),
      sourceTemplateId: v1.templateId
    });
    await runtime.engine.publishTemplate({ templateId: v2.templateId, version: 2 }, 'demo');

    const first = await runtime.engine.compile({
      tenant: 'demo',
      documentType: 'invoice',
      template: { templateId: v1.templateId, version: 1 },
      data: SAMPLE_DATA,
      generatedAt: '2026-03-14T08:00:00Z'
    });
    const again = await runtime.engine.compile({
      tenant: 'demo',
      documentType: 'invoice',
      template: { templateId: v1.templateId, version: 1 },
      data: SAMPLE_DATA,
      generatedAt: '2026-03-14T08:00:00Z'
    });
    assert.equal(first.html, again.html);
    assert.ok(!first.html.includes('(v2)'));
  } finally {
    await cleanup(runtime.dataDir);
  }
});
