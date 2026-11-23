'use strict';

/**
 * Conformance runner (SPEC D-5).
 *
 * Evaluates the dialect corpus against the same parser the server and the
 * browser editor use, so "the editor accepts what the renderer rejects" cannot
 * happen silently.
 *
 *   node conformance/run.js
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const { SchemaRegistry } = require('../src/schema');
const { compileSchema } = require('../src/schema');
const { analyze } = require('../src/liquid');

const invoice = compileSchema({
  documentType: 'conformance-test',
  schemaVersion: 1,
  root: [
    { name: 'invoiceNumber', displayLabel: 'Number', dataType: 'string', sampleValue: 'INV-1' },
    { name: 'issuedOn', displayLabel: 'Issued', dataType: 'date', formatHint: 'yyyy-MM-dd', sampleValue: '2026-01-01' },
    { name: 'dueOn', displayLabel: 'Due', dataType: 'date', formatHint: 'yyyy-MM-dd', sampleValue: '2026-01-02' },
    { name: 'customerName', displayLabel: 'Customer', dataType: 'string', sampleValue: 'C' },
    { name: 'customerAddress', displayLabel: 'Address', dataType: 'string', sampleValue: 'A' },
    { name: 'notes', displayLabel: 'Notes', dataType: 'string', sampleValue: 'N' },
    { name: 'total', displayLabel: 'Total', dataType: 'money', formatHint: '#,##0.00', sampleValue: 1 },
    {
      name: 'items',
      displayLabel: 'Items',
      dataType: 'collection',
      isCollection: true,
      loopVariable: 'item',
      sampleValue: null,
      children: [
        { name: 'description', displayLabel: 'D', dataType: 'string', sampleValue: 'x' },
        {
          name: 'parts',
          displayLabel: 'Parts',
          dataType: 'collection',
          isCollection: true,
          loopVariable: 'part',
          sampleValue: null,
          children: [{ name: 'sku', displayLabel: 'S', dataType: 'string', sampleValue: 'p' }]
        }
      ]
    }
  ]
});

const fixtures = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8')
);

let passed = 0;
const failures = [];

for (const fixture of fixtures) {
  const report = analyze(fixture.content, invoice, {});
  const codes = [
    ...report.syntaxErrors.map((item) => item.code),
    ...report.unknownTokens.map(() => 'UNKNOWN_TOKEN')
  ];
  try {
    if (fixture.expect.ok) {
      assert.deepEqual(report.syntaxErrors, [], `${fixture.name}: unexpected syntax errors`);
      assert.deepEqual(report.unknownTokens, [], `${fixture.name}: unexpected unknown tokens`);
      if (fixture.expect.warning) {
        assert.ok(
          report.warnings.some((warning) => warning.code === fixture.expect.warning),
          `${fixture.name}: expected warning ${fixture.expect.warning}`
        );
      }
    } else {
      assert.ok(
        codes.includes(fixture.expect.code),
        `${fixture.name}: expected ${fixture.expect.code}, got [${codes.join(', ')}]`
      );
      if (fixture.expect.suggestion) {
        assert.equal(
          report.unknownTokens[0] && report.unknownTokens[0].suggestion,
          fixture.expect.suggestion,
          `${fixture.name}: wrong suggestion`
        );
      }
    }
    passed += 1;
  } catch (error) {
    failures.push(error.message);
  }
}

const total = fixtures.length;
process.stdout.write(`conformance: ${passed}/${total} fixtures passed\n`);
if (failures.length) {
  for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`);
  process.exit(1);
}
