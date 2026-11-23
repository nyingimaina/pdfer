'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze, compileText, scanTokens } = require('../src/liquid');
const { compileSchema } = require('../src/schema');

const schema = compileSchema({
  documentType: 'invoice',
  schemaVersion: 1,
  root: [
    { name: 'invoiceNumber', displayLabel: 'Number', dataType: 'string', sampleValue: 'INV-1' },
    { name: 'issuedOn', displayLabel: 'Issued', dataType: 'date', formatHint: 'yyyy-MM-dd', sampleValue: '2026-01-01' },
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

test('unknown tokens carry a location and a suggestion', () => {
  const report = analyze('<p>{{ issuedOnn }}</p>', schema, {});
  assert.equal(report.unknownTokens.length, 1);
  assert.equal(report.unknownTokens[0].suggestion, 'issuedOn');
  assert.deepEqual(report.unknownTokens[0].location, { line: 1, column: 6 });
});

test('nested loops resolve their own loop variables', () => {
  const tpl = `{% for item in items %}{% for part in item.parts %}{{ part.sku }}{% endfor %}{% endfor %}`;
  const report = analyze(tpl, schema, {});
  assert.deepEqual(report.syntaxErrors, []);
  assert.deepEqual(report.unknownTokens, []);
});

test('collection children outside their loop are rejected with guidance', () => {
  const report = analyze('{{ item.description }}', schema, {});
  assert.equal(report.syntaxErrors[0].code, 'TYPE_MISMATCH');
  assert.match(report.syntaxErrors[0].message, /for item in items/);
});

test('disallowed tags are rejected with a location', () => {
  for (const tpl of ['{% capture x %}a{% endcapture %}', '{% include "x" %}', '{% case x %}{% endcase %}']) {
    const report = analyze(tpl, schema, {});
    assert.equal(report.syntaxErrors[0].code, 'TAG_NOT_ALLOWED', tpl);
    assert.ok(report.syntaxErrors[0].location.line >= 1);
  }
});

test('disallowed filters are rejected, including formatting filters', () => {
  for (const tpl of ['{{ total | times: 2 }}', '{{ issuedOn | date: "%Y" }}', '{{ invoiceNumber | where: "x" }}']) {
    const report = analyze(tpl, schema, {});
    assert.ok(
      report.syntaxErrors.some((error) => error.code === 'FILTER_NOT_ALLOWED'),
      tpl
    );
  }
});

test('script, event handlers and frames are unsafe', () => {
  const report = analyze(
    '<div onclick="x()"><script>alert(1)</script><iframe src="a"></iframe></div>',
    schema,
    {}
  );
  const codes = report.syntaxErrors.map((error) => error.code);
  assert.ok(codes.filter((code) => code === 'UNSAFE_MARKUP').length >= 3);
});

test('external references are rejected and relative ones collected', () => {
  const report = analyze(
    '<style>@import url("https://x/y.css"); .a{background:url(./assets/a.png)}</style><img src="https://x/b.png">',
    schema,
    {}
  );
  assert.ok(report.syntaxErrors.some((error) => error.code === 'EXTERNAL_REFERENCE_REJECTED'));
  assert.deepEqual(report.assetRefs, ['assets/a.png']);
});

test('hardcoded page numbers produce a warning only', () => {
  const report = analyze('<div class="pageNumber"></div>', schema, {});
  assert.deepEqual(report.syntaxErrors, []);
  assert.equal(report.warnings[0].code, 'HARDCODED_PAGE_NUMBER');
});

test('unclosed sections are reported', () => {
  const report = analyze('{% for item in items %}x', schema, {});
  assert.equal(report.syntaxErrors[0].code, 'UNCLOSED_SECTION');
});

test('whitespace control and raw blocks round-trip', () => {
  const output = compileText(
    '{%- for item in items -%}  {{- item.description -}}  {%- endfor -%}{% raw %}{{ literal }}{% endraw %}',
    { items: [{ description: 'A' }] }
  );
  assert.equal(output, 'A{{ literal }}');
});

test('bracket access is rejected', () => {
  const report = analyze('{{ items[0].description }}', schema, {});
  assert.ok(report.syntaxErrors.some((error) => error.code === 'TEMPLATE_SYNTAX_ERROR'));
});

test('scanner tolerates CRLF and reports stable lines', () => {
  const { tokens } = scanTokens('line1\r\n{{ a }}\r\n{% if b %}{% endif %}');
  assert.equal(tokens.length, 3);
  assert.equal(tokens[0].line, 2);
  assert.equal(tokens[1].line, 3);
});
