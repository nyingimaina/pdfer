'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatNumber,
  formatTemporal,
  parseNumericPattern,
  coerceNumericInput,
  assertHint
} = require('../src/format');

test('numeric patterns: grouping only when declared', () => {
  assert.equal(formatNumber(1250, '#,##0.00'), '1,250.00');
  assert.equal(formatNumber(1250, '0.00'), '1250.00');
  assert.equal(formatNumber(1234567.891, '#,##0.00'), '1,234,567.89');
  assert.equal(formatNumber(0, '#,##0.00'), '0.00');
  assert.equal(formatNumber(-42.5, '#,##0.00'), '-42.50');
});

test('numeric patterns: literal prefix and suffix', () => {
  assert.equal(formatNumber(1250, '€ #,##0.00'), '€ 1,250.00');
  assert.equal(formatNumber(1250, '#,##0.00 EUR'), '1,250.00 EUR');
  assert.equal(formatNumber(-3.5, '$#,##0.00'), '$-3.50');
});

test('numeric patterns: rounding is half away from zero', () => {
  assert.equal(formatNumber(1.005, '0.00'), '1.01');
  assert.equal(formatNumber(2.675, '0.00'), '2.68');
  assert.equal(formatNumber(-0.001, '0.00'), '0.00');
  assert.equal(formatNumber(9.999, '#,##0.0'), '10.0');
});

test('numeric patterns: optional decimals trim', () => {
  assert.equal(formatNumber(2.5, '0.###'), '2.5');
  assert.equal(formatNumber(2, '0.###'), '2');
  assert.equal(formatNumber(2.5001, '0.##'), '2.5');
});

test('numeric patterns: rejects hints without a pattern', () => {
  assert.throws(() => parseNumericPattern('EUR'), /no digit pattern/);
});

test('dates are formatted in UTC regardless of host timezone', () => {
  assert.equal(formatTemporal('2026-03-14T23:30:00Z', 'yyyy-MM-dd HH:mm'), '2026-03-14 23:30');
  assert.equal(formatTemporal('2026-03-04', 'dd/MM/yyyy'), '04/03/2026');
  assert.equal(formatTemporal('2026-01-05T04:05:06Z', 'yy-M-d H:mm:ss'), '26-1-5 4:05:06');
});

test('dates reject impossible values', () => {
  assert.throws(() => formatTemporal('2026-02-30', 'yyyy-MM-dd'));
  assert.throws(() => formatTemporal('not-a-date', 'yyyy-MM-dd'));
});

test('numeric input coercion', () => {
  assert.equal(coerceNumericInput(12.5), 12.5);
  assert.equal(coerceNumericInput('12.50'), 12.5);
  assert.equal(coerceNumericInput('1,250.00'), undefined);
  assert.equal(coerceNumericInput('12,5'), undefined);
  assert.equal(coerceNumericInput(true), undefined);
});

test('hints are validated at registration', () => {
  assert.doesNotThrow(() => assertHint('money', '#,##0.00'));
  assert.doesNotThrow(() => assertHint('date', 'yyyy-MM-dd'));
  assert.throws(() => assertHint('money', 'abc'));
  assert.throws(() => assertHint('date', 'abc'));
  assert.throws(() => assertHint('string', 'yyyy'));
});
