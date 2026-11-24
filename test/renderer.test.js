'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { GotenbergRenderer } = require('../src/ports/renderer');

async function minimalPdf() {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save());
}

async function pdfResponse() {
  const bytes = await minimalPdf();
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/pdf' }
  });
}

function capture() {
  const state = { calls: 0, form: null };
  return {
    state,
    install(t) {
      const original = global.fetch;
      global.fetch = async (_url, init) => {
        state.calls += 1;
        state.form = init.body;
        if (state.respond) return state.respond();
        return pdfResponse();
      };
      t.after(() => {
        global.fetch = original;
      });
    }
  };
}

async function readForm(form) {
  const entries = [...form.entries()];
  const files = entries.filter(([key]) => key === 'files').map(([, value]) => value);
  const fields = {};
  for (const [key, value] of entries) {
    if (key !== 'files') fields[key] = String(value);
  }
  return {
    names: files.map((file) => file.name),
    texts: await Promise.all(files.map((file) => file.text())),
    fields
  };
}

test('assets reach the renderer under flat names and the HTML follows', async (t) => {
  const renderer = new GotenbergRenderer({ baseUrl: 'http://renderer.test' });
  const c = capture();
  c.install(t);

  const asset = {
    path: 'assets/logo.png',
    bytes: Buffer.from('png-bytes'),
    mimeType: 'image/png',
    sha256: 'a'.repeat(64)
  };

  await renderer.render({
    html: '<img src="./assets/logo.png">',
    assets: [asset],
    headerHtml: '<img src="./assets/logo.png">',
    footerHtml: null,
    options: {}
  });

  const form = await readForm(c.state.form);
  assert.deepEqual(form.names, ['index.html', 'aaaaaaaaaaaa-logo.png', 'header.html']);
  assert.match(form.texts[0], /src="\.\/aaaaaaaaaaaa-logo\.png"/);
  assert.doesNotMatch(form.texts[0], /assets\/logo\.png/);
  assert.match(form.texts[2], /src="\.\/aaaaaaaaaaaa-logo\.png"/);
});

test('the renderer is told to fail when a sub-resource does not load', async (t) => {
  const renderer = new GotenbergRenderer({ baseUrl: 'http://renderer.test' });
  const c = capture();
  c.install(t);

  await renderer.render({ html: '<p>hi</p>', assets: [], options: {} });

  const { fields } = await readForm(c.state.form);
  assert.equal(fields.failOnResourceLoadingFailed, 'true');
  assert.deepEqual(JSON.parse(fields.failOnResourceHttpStatusCodes), [404, 499, 500, 502, 503, 504]);
  assert.equal(fields.failOnHttpStatusCodes, JSON.stringify([499, 500, 501, 502, 503, 504]));
});

test('a failed sub-resource becomes a non-retriable RENDER_RESOURCE_FAILED', async (t) => {
  const renderer = new GotenbergRenderer({ baseUrl: 'http://renderer.test' });
  const c = capture();
  c.install(t);
  c.state.respond = () =>
    new Response('Chromium failed to load resources: resource Image: net::ERR_FILE_NOT_FOUND', {
      status: 409
    });

  await assert.rejects(
    renderer.render({ html: '<img src="./assets/a.png">', assets: [], options: {} }),
    (error) => {
      assert.equal(error.code, 'RENDER_RESOURCE_FAILED');
      assert.equal(error.status, 502);
      assert.equal(error.retriable, false);
      assert.match(error.message, /resource/i);
      return true;
    }
  );
  assert.equal(c.state.calls, 1, 'a deterministic failure must not be retried');
});

test('a resource status-code failure is also RENDER_RESOURCE_FAILED', async (t) => {
  const renderer = new GotenbergRenderer({ baseUrl: 'http://renderer.test' });
  const c = capture();
  c.install(t);
  c.state.respond = () =>
    new Response('Invalid HTTP status code from resources:\nhttps://x/y.png: 404', { status: 409 });

  await assert.rejects(
    renderer.render({ html: '<p>hi</p>', assets: [], options: {} }),
    (error) => {
      assert.equal(error.code, 'RENDER_RESOURCE_FAILED');
      assert.equal(error.retriable, false);
      return true;
    }
  );
});

test('other renderer conflicts stay RENDER_FAILED', async (t) => {
  const renderer = new GotenbergRenderer({ baseUrl: 'http://renderer.test', retries: 0 });
  const c = capture();
  c.install(t);
  c.state.respond = () => new Response('Chromium console exceptions: boom', { status: 409 });

  await assert.rejects(
    renderer.render({ html: '<p>hi</p>', assets: [], options: {} }),
    (error) => {
      assert.equal(error.code, 'RENDER_FAILED');
      return true;
    }
  );
});

test('a 503 stays RENDERER_UNAVAILABLE and is retriable', async (t) => {
  const renderer = new GotenbergRenderer({ baseUrl: 'http://renderer.test', retries: 0 });
  const c = capture();
  c.install(t);
  c.state.respond = () => new Response('not ready', { status: 503 });

  await assert.rejects(
    renderer.render({ html: '<p>hi</p>', assets: [], options: {} }),
    (error) => {
      assert.equal(error.code, 'RENDERER_UNAVAILABLE');
      assert.equal(error.retriable, true);
      return true;
    }
  );
});
