'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Binder, buildSampleData } = require('../src/binder');
const { compileSchema } = require('../src/schema');

const schema = compileSchema({
  documentType: 'invoice',
  schemaVersion: 1,
  root: [
    { name: 'ref', displayLabel: 'Ref', dataType: 'string', isRequired: true, sampleValue: 'R1' },
    { name: 'note', displayLabel: 'Note', dataType: 'string', isRequired: false, sampleValue: 'n' },
    { name: 'body', displayLabel: 'Body', dataType: 'html', isRequired: false, sampleValue: '<b>x</b>' },
    { name: 'total', displayLabel: 'Total', dataType: 'money', isRequired: true, formatHint: '#,##0.00', sampleValue: 1 },
    { name: 'issuedOn', displayLabel: 'Issued', dataType: 'date', isRequired: true, formatHint: 'yyyy-MM-dd', sampleValue: '2026-01-01' },
    {
      name: 'items',
      displayLabel: 'Items',
      dataType: 'collection',
      isCollection: true,
      loopVariable: 'item',
      sampleValue: null,
      children: [
        { name: 'sku', displayLabel: 'SKU', dataType: 'string', isRequired: true, sampleValue: 'S' }
      ]
    }
  ]
});

const binder = new Binder({ maxRows: 10 });

test('binds, formats and escapes', () => {
  const model = binder.bind(
    {
      ref: 'A & B',
      note: null,
      body: '<b>bold</b>',
      total: 1250,
      issuedOn: '2026-03-14',
      items: [{ sku: '<x>' }]
    },
    schema
  );
  assert.equal(model.ref, 'A &amp; B');
  assert.equal(model.note, null);
  assert.equal(model.body, '<b>bold</b>');
  assert.equal(model.total, '1,250.00');
  assert.equal(model.issuedOn, '2026-03-14');
  assert.equal(model.items[0].sku, '&lt;x&gt;');
});

test('rejects pre-formatted money', () => {
  assert.throws(
    () =>
      binder.bind(
        { ref: 'r', total: '1,250.00', issuedOn: '2026-03-14', items: [] },
        schema
      ),
    (error) => error.code === 'TYPE_MISMATCH'
  );
});

test('accepts canonical decimal strings', () => {
  const model = binder.bind(
    { ref: 'r', total: '1250.50', issuedOn: '2026-03-14', items: [] },
    schema
  );
  assert.equal(model.total, '1,250.50');
});

test('unknown keys are a hard error, never ignored', () => {
  assert.throws(
    () =>
      binder.bind(
        { ref: 'r', total: 1, issuedOn: '2026-03-14', items: [], surprise: true },
        schema
      ),
    (error) => error.code === 'UNKNOWN_DATA_KEY'
  );
});

test('unknown keys inside collections are reported with a path', () => {
  assert.throws(
    () =>
      binder.bind(
        { ref: 'r', total: 1, issuedOn: '2026-03-14', items: [{ sku: 's', extra: 1 }] },
        schema
      ),
    (error) => {
      assert.equal(error.code, 'UNKNOWN_DATA_KEY');
      assert.equal(error.details.issues[0].token, 'items[0].extra');
      return true;
    }
  );
});

test('required values are enforced', () => {
  assert.throws(
    () => binder.bind({ total: 1, issuedOn: '2026-03-14', items: [] }, schema),
    (error) => error.code === 'REQUIRED_PLACEHOLDER_MISSING'
  );
});

test('boolean must be a boolean, not a string', () => {
  const s = compileSchema({
    documentType: 'x-test',
    schemaVersion: 1,
    root: [{ name: 'flag', displayLabel: 'Flag', dataType: 'boolean', sampleValue: true }]
  });
  assert.throws(() => binder.bind({ flag: 'true' }, s), (e) => e.code === 'TYPE_MISMATCH');
  assert.equal(binder.bind({ flag: true }, s).flag, true);
});

test('row limit fails before rendering', () => {
  const rows = Array.from({ length: 11 }, () => ({ sku: 's' }));
  assert.throws(
    () => binder.bind({ ref: 'r', total: 1, issuedOn: '2026-03-14', items: rows }, schema),
    (error) => error.code === 'PAGINATION_LIMIT_EXCEEDED'
  );
});

test('sample data satisfies the schema and has two rows', () => {
  const sample = buildSampleData(schema);
  assert.equal(sample.items.length, 2);
  assert.doesNotThrow(() => binder.bind(sample, schema));
});
