'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { compileSchema, SchemaRegistry } = require('../src/schema');

function base(overrides = {}) {
  return {
    documentType: 'invoice',
    schemaVersion: 1,
    root: [
      {
        name: 'number',
        displayLabel: 'Number',
        dataType: 'string',
        isRequired: true,
        sampleValue: 'INV-1'
      }
    ],
    ...overrides
  };
}

test('reserved root tokens are rejected', () => {
  for (const token of ['title', 'generatedAt', 'documentType']) {
    const definition = base({
      root: [{ name: token, displayLabel: token, dataType: 'string', sampleValue: 'x' }]
    });
    assert.throws(() => compileSchema(definition), /reserved/);
  }
});

test('reserved loop variables are rejected', () => {
  assert.throws(
    () =>
      compileSchema(
        base({
          root: [
            {
              name: 'items',
              displayLabel: 'Items',
              dataType: 'collection',
              isCollection: true,
              loopVariable: 'forloop',
              children: [
                { name: 'a', displayLabel: 'A', dataType: 'string', sampleValue: 'x' }
              ]
            }
          ]
        })
      ),
    /reserved/
  );
});

test('loop variables must be unique', () => {
  assert.throws(
    () =>
      compileSchema(
        base({
          root: [
            {
              name: 'items',
              displayLabel: 'Items',
              dataType: 'collection',
              isCollection: true,
              loopVariable: 'row',
              children: [
                {
                  name: 'parts',
                  displayLabel: 'Parts',
                  dataType: 'collection',
                  isCollection: true,
                  loopVariable: 'row',
                  children: [
                    { name: 'sku', displayLabel: 'SKU', dataType: 'string', sampleValue: 'x' }
                  ]
                }
              ]
            }
          ]
        })
      ),
    /more than once/
  );
});

test('children rules and isCollection consistency', () => {
  assert.throws(
    () =>
      compileSchema(
        base({
          root: [
            {
              name: 'items',
              displayLabel: 'Items',
              dataType: 'collection',
              isCollection: false,
              children: []
            }
          ]
        })
      ),
    /isCollection/
  );
  assert.throws(
    () =>
      compileSchema(
        base({
          root: [
            {
              name: 'a',
              displayLabel: 'A',
              dataType: 'string',
              sampleValue: 'x',
              children: [{ name: 'b', displayLabel: 'B', dataType: 'string', sampleValue: 'y' }]
            }
          ]
        })
      ),
    /must not declare children/
  );
});

test('nesting depth is capped at four levels', () => {
  const leaf = { name: 'a', displayLabel: 'A', dataType: 'string', sampleValue: 'x' };
  const level = (depth) =>
    depth === 1
      ? leaf
      : {
          name: `c${depth}`,
          displayLabel: 'C',
          dataType: 'collection',
          isCollection: true,
          loopVariable: `v${depth}`,
          children: [level(depth - 1)]
        };
  assert.throws(() => compileSchema(base({ root: [level(6)] })), /deeper than 4/);
});

test('money sample must be numeric', () => {
  assert.throws(
    () =>
      compileSchema(
        base({
          root: [
            {
              name: 'total',
              displayLabel: 'Total',
              dataType: 'money',
              formatHint: '#,##0.00',
              sampleValue: '1,250.00'
            }
          ]
        })
      ),
    /must be a number/
  );
});

test('tokens are derived from loop variables', () => {
  const schema = compileSchema(
    base({
      root: [
        {
          name: 'items',
          displayLabel: 'Items',
          dataType: 'collection',
          isCollection: true,
          loopVariable: 'item',
          children: [
            { name: 'description', displayLabel: 'D', dataType: 'string', sampleValue: 'x' }
          ]
        }
      ]
    })
  );
  assert.ok(schema.byToken.has('item.description'));
  assert.ok(schema.byToken.has('items'));
  assert.deepEqual(schema.rootTokens, ['items']);
});

test('registry resolves latest and pinned versions, and keeps history', () => {
  const registry = new SchemaRegistry();
  registry.register(base());
  registry.register(
    base({
      schemaVersion: 2,
      root: [{ name: 'extra', displayLabel: 'Extra', dataType: 'string', sampleValue: 'y' }]
    })
  );
  assert.equal(registry.resolve('invoice').schemaVersion, 2);
  assert.equal(registry.resolve('invoice', 1).schemaVersion, 1);
  assert.throws(() => registry.resolve('invoice', 9), /Unknown schema version/);
  assert.throws(() => registry.resolve('nope'), /Unknown document type/);
});
