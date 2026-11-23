'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldStopIdle } = require('../src/rendererProcess');

const base = {
  enabled: true,
  now: 1_000_000,
  lastBusyAt: 1_000_000 - 10_000,
  idleSeconds: 30,
  active: 0,
  queued: 0
};

test('idle stop is opt-in', () => {
  assert.equal(shouldStopIdle({ ...base, enabled: false }), false);
  assert.equal(shouldStopIdle({ ...base, enabled: true }), false);
});

test('idle stop waits for the idle window', () => {
  assert.equal(
    shouldStopIdle({ ...base, now: base.lastBusyAt + 29_000 }),
    false
  );
  assert.equal(
    shouldStopIdle({ ...base, now: base.lastBusyAt + 30_000 }),
    true
  );
});

test('idle stop never interrupts work', () => {
  assert.equal(shouldStopIdle({ ...base, now: base.lastBusyAt + 60_000, active: 1 }), false);
  assert.equal(shouldStopIdle({ ...base, now: base.lastBusyAt + 60_000, queued: 1 }), false);
});

test('idle stop needs a configured window', () => {
  assert.equal(shouldStopIdle({ ...base, idleSeconds: 0 }), false);
});
