'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { OutputStore } = require('../src/ports/outputStore');
const { FixedWindowLimiter, timingSafeEquals, metricsText } = require('../src/http/app');

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'pdfer-retention-'));
}

test('retention sweep removes only artifacts older than the cutoff', async () => {
  const root = await tempDir();
  const oldClock = { now: () => '2020-01-01T00:00:00.000Z' };
  const newClock = { now: () => new Date().toISOString() };

  const oldStore = new OutputStore({ root, clock: oldClock });
  await oldStore.init();
  const oldArtifact = await oldStore.save('demo', {
    fileName: 'old.pdf',
    bytes: Buffer.from('%PDF-1.4 old'),
    provenance: {}
  });

  const newStore = new OutputStore({ root, clock: newClock });
  const newArtifact = await newStore.save('demo', {
    fileName: 'new.pdf',
    bytes: Buffer.from('%PDF-1.4 new'),
    provenance: {}
  });

  const result = await newStore.sweep({ maxAgeDays: 30 });
  assert.equal(result.removed, 1);
  assert.ok(result.bytes > 0);

  await assert.rejects(() => newStore.stat(oldArtifact.handle, 'demo'), /Unknown artifact/);
  const survivor = await newStore.stat(newArtifact.handle, 'demo');
  assert.equal(survivor.fileName, 'new.pdf');

  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

test('retention sweep is a no-op when disabled', async () => {
  const root = await tempDir();
  const store = new OutputStore({ root, clock: { now: () => '2020-01-01T00:00:00.000Z' } });
  await store.init();
  await store.save('demo', { fileName: 'a.pdf', bytes: Buffer.from('%PDF-1.4 a') });
  const result = await store.sweep({ maxAgeDays: 0 });
  assert.deepEqual(result, { removed: 0, bytes: 0 });
  await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
});

test('fixed-window limiter allows up to the limit then refuses', () => {
  const limiter = new FixedWindowLimiter({ limit: 2, windowMs: 60000 });
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), true);
  assert.equal(limiter.allow('a'), false);
  assert.equal(limiter.allow('b'), true);
});

test('a disabled limiter always allows', () => {
  const limiter = new FixedWindowLimiter({ limit: 0, windowMs: 60000 });
  for (let index = 0; index < 100; index++) assert.equal(limiter.allow('a'), true);
});

test('api key comparison is length-safe and exact', () => {
  assert.equal(timingSafeEquals('secret', 'secret'), true);
  assert.equal(timingSafeEquals('secret', 'secreT'), false);
  assert.equal(timingSafeEquals('secret', 'secret-longer'), false);
  assert.equal(timingSafeEquals('', ''), true);
  assert.equal(timingSafeEquals(undefined, 'x'), false);
});

test('metrics expose a histogram and gauges', () => {
  const text = metricsText({ queueDepth: 3, activeRenders: 1 });
  assert.match(text, /pdfer_render_duration_seconds_bucket\{le="0\.5"\}/);
  assert.match(text, /pdfer_render_duration_seconds_count/);
  assert.match(text, /pdfer_render_queue_depth 3/);
  assert.match(text, /pdfer_render_active 1/);
});
