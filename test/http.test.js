'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../src/http/app');
const {
  makeRuntime,
  cleanup,
  FakeRenderer,
  SAMPLE_DATA,
  createPublishedTemplate
} = require('./helpers');

async function makeApp(overrides = {}) {
  const runtime = await makeRuntime(overrides);
  const app = buildApp({
    engine: runtime.engine,
    config: runtime.config,
    rendererProcess: null,
    logger: runtime.logger,
    registry: runtime.registry
  });
  await app.ready();
  return { app, runtime };
}

test('health, readiness and version endpoints', async () => {
  const { app, runtime } = await makeApp();
  try {
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200);
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(ready.statusCode, 200);
    const version = await app.inject({ method: 'GET', url: '/version' });
    assert.equal(JSON.parse(version.body).engine, '1.1.0');

    runtime.renderer.healthy = false;
    runtime.renderer.healthCache = { at: 0, value: { ok: false, status: 'down', version: null } };
    const down = await app.inject({ method: 'GET', url: '/readyz' });
    assert.equal(down.statusCode, 503);
    assert.equal(JSON.parse(down.body).error.code, 'RENDERER_UNAVAILABLE');
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('validate returns 200 with a verdict, never a 4xx for a bad template', async () => {
  const { app, runtime } = await makeApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        inlineTemplate: { syntaxId: 'liquid', content: '<p>{{ invoiceDate }}</p>' }
      }
    });
    assert.equal(response.statusCode, 200);
    const report = JSON.parse(response.body);
    assert.equal(report.isRenderable, false);
    assert.equal(report.unknownTokens[0].token, 'invoiceDate');
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('malformed JSON is 422, semantic rejection is 400', async () => {
  const { app, runtime } = await makeApp();
  try {
    const malformed = await app.inject({
      method: 'POST',
      url: '/render',
      headers: { 'content-type': 'application/json' },
      payload: '{"tenant":'
    });
    assert.equal(malformed.statusCode, 422);
    assert.equal(JSON.parse(malformed.body).error.code, 'REQUEST_INVALID');

    const unknownField = await app.inject({
      method: 'POST',
      url: '/validate',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        inlineTemplate: { syntaxId: 'liquid', content: 'x' },
        surprise: true
      }
    });
    assert.equal(unknownField.statusCode, 400);
    assert.equal(JSON.parse(unknownField.body).error.code, 'REQUEST_INVALID');
    assert.ok(JSON.parse(unknownField.body).error.details.requestId);
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('render returns a PDF stream with provenance headers', async () => {
  const { app, runtime } = await makeApp();
  try {
    await createPublishedTemplate(runtime);
    const response = await app.inject({
      method: 'POST',
      url: '/render',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        mode: 'production',
        template: 'default',
        data: SAMPLE_DATA,
        generatedAt: '2026-03-14T08:00:00Z'
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /application\/pdf/);
    assert.equal(response.headers['x-page-count'], '2');
    assert.equal(response.headers['x-schema-version'], '1');
    assert.equal(response.headers['x-template-version'], '1');
    assert.ok(response.headers['x-artifact-handle'].startsWith('art_'));
    assert.ok(response.rawPayload.subarray(0, 5).toString() === '%PDF-');
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('preview with sample data needs no business data', async () => {
  const { app, runtime } = await makeApp();
  try {
    await createPublishedTemplate(runtime);
    const response = await app.inject({
      method: 'POST',
      url: '/preview',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        template: 'default',
        useSampleData: true,
        generatedAt: '2026-03-14T08:00:00Z'
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /application\/pdf/);
    assert.equal(response.headers['x-artifact-handle'], undefined);
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('templates are tenant-scoped over HTTP', async () => {
  const { app, runtime } = await makeApp();
  try {
    const saved = await createPublishedTemplate(runtime);
    const foreign = await app.inject({
      method: 'GET',
      url: `/templates/${saved.templateId}?tenant=other&version=1`
    });
    assert.equal(foreign.statusCode, 404);
    assert.equal(JSON.parse(foreign.body).error.code, 'TEMPLATE_NOT_FOUND');

    const missingTenant = await app.inject({
      method: 'GET',
      url: `/templates/${saved.templateId}?version=1`
    });
    assert.equal(missingTenant.statusCode, 400);
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('template lifecycle over HTTP: save, publish, default, retire', async () => {
  const { app, runtime } = await makeApp();
  try {
    const saved = await app.inject({
      method: 'POST',
      url: '/templates',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        syntaxId: 'liquid',
        content: '<p>{{ invoiceNumber }}</p>',
        displayLabel: 'HTTP template'
      }
    });
    assert.equal(saved.statusCode, 200);
    const { templateId, version } = JSON.parse(saved.body);
    assert.equal(version, 1);

    for (const action of ['publish', 'default']) {
      const response = await app.inject({
        method: 'POST',
        url: `/templates/${templateId}/versions/${version}/${action}?tenant=demo`
      });
      assert.equal(response.statusCode, 204, action);
    }

    const listing = await app.inject({
      method: 'GET',
      url: '/templates?tenant=demo&documentType=invoice'
    });
    const page = JSON.parse(listing.body);
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].isDefault, true);
    assert.equal(page.items[0].content, undefined, 'listing must not leak content');

    const retire = await app.inject({
      method: 'POST',
      url: `/templates/${templateId}/versions/${version}/retire?tenant=demo`
    });
    assert.equal(retire.statusCode, 204);

    const render = await app.inject({
      method: 'POST',
      url: '/render',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        mode: 'production',
        template: 'default',
        data: { invoiceNumber: 'INV-1', issuedOn: '2026-01-01', customerName: 'C', total: 1 },
        generatedAt: '2026-03-14T08:00:00Z'
      }
    });
    assert.equal(render.statusCode, 404);
    assert.equal(JSON.parse(render.body).error.code, 'NO_DEFAULT_TEMPLATE');
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('assets can be uploaded and reused, but not across tenants', async () => {
  const { app, runtime } = await makeApp();
  try {
    const upload = await app.inject({
      method: 'PUT',
      url: '/assets/assets/logo.svg?tenant=acme',
      headers: { 'content-type': 'image/svg+xml' },
      payload: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    });
    assert.equal(upload.statusCode, 200);
    const meta = JSON.parse(upload.body);
    assert.equal(meta.path, 'assets/logo.svg');
    assert.match(meta.sha256, /^sha256:/);

    const list = await app.inject({ method: 'GET', url: '/assets?tenant=acme' });
    assert.equal(JSON.parse(list.body).length, 1);

    const other = await app.inject({ method: 'GET', url: '/assets?tenant=other' });
    assert.deepEqual(JSON.parse(other.body), []);

    const traversal = await app.inject({
      method: 'PUT',
      url: '/assets/C:/secrets.txt?tenant=acme',
      headers: { 'content-type': 'text/plain' },
      payload: Buffer.from('x')
    });
    assert.equal(traversal.statusCode, 400);
    assert.equal(JSON.parse(traversal.body).error.code, 'ASSET_REJECTED');
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('async render follows 202 -> 303 -> artifact', async () => {
  const { app, runtime } = await makeApp();
  try {
    await createPublishedTemplate(runtime);
    const accepted = await app.inject({
      method: 'POST',
      url: '/render',
      headers: { prefer: 'respond-async' },
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        mode: 'production',
        template: 'default',
        data: SAMPLE_DATA,
        generatedAt: '2026-03-14T08:00:00Z'
      }
    });
    assert.equal(accepted.statusCode, 202);
    const location = accepted.headers.location;
    assert.match(location, /^\/v1\/jobs\/job_/);

    let response;
    for (let attempt = 0; attempt < 50; attempt++) {
      response = await app.inject({ method: 'GET', url: `${location}?tenant=demo` });
      if (response.statusCode !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(response.statusCode, 303);
    const artifactLocation = response.headers.location;

    const artifact = await app.inject({ method: 'GET', url: artifactLocation });
    assert.equal(artifact.statusCode, 200);
    assert.match(artifact.headers['content-type'], /application\/pdf/);
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('api key auth can be enabled', async () => {
  const { app, runtime } = await makeApp({ config: { authMode: 'apikey', apiKey: 'secret' } });
  try {
    const denied = await app.inject({ method: 'GET', url: '/document-types?tenant=demo' });
    assert.equal(denied.statusCode, 401);
    assert.equal(JSON.parse(denied.body).error.code, 'UNAUTHORIZED');

    const allowed = await app.inject({
      method: 'GET',
      url: '/document-types?tenant=demo',
      headers: { authorization: 'Bearer secret' }
    });
    assert.equal(allowed.statusCode, 200);

    const health = await app.inject({ method: 'GET', url: '/healthz' });
    assert.equal(health.statusCode, 200, 'health checks are never authenticated');
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('metrics expose counters without tenant labels', async () => {
  const { app, runtime } = await makeApp();
  try {
    await createPublishedTemplate(runtime);
    await app.inject({
      method: 'POST',
      url: '/render',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        mode: 'production',
        template: 'default',
        data: SAMPLE_DATA,
        generatedAt: '2026-03-14T08:00:00Z'
      }
    });
    const metrics = await app.inject({ method: 'GET', url: '/metrics' });
    assert.match(metrics.body, /pdfer_renders_total\{outcome="ok"\} [1-9]/);
    assert.ok(!metrics.body.includes('demo'));
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});

test('compile returns html and skips the renderer', async () => {
  const { app, runtime } = await makeApp();
  try {
    await createPublishedTemplate(runtime);
    const renderer = new FakeRenderer();
    runtime.engine.renderer = renderer;
    const response = await app.inject({
      method: 'POST',
      url: '/compile',
      payload: {
        tenant: 'demo',
        documentType: 'invoice',
        template: 'default',
        data: SAMPLE_DATA,
        generatedAt: '2026-03-14T08:00:00Z'
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/html/);
    assert.match(response.body, /INV-2026-00417/);
    assert.equal(renderer.calls.length, 0);
  } finally {
    await app.close();
    await cleanup(runtime.dataDir);
  }
});
