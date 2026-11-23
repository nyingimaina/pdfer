'use strict';

/**
 * PDF output assertions without a PDF toolchain (SPEC I-10, T-12).
 *
 *   node scripts/pdf-assert.js tmp/invoice.pdf 2
 *
 * Checks: page count, footer numbering on every page, and that the rendered
 * text is extractable (embedded fonts, not vector outlines). Also prints a
 * short text sample so layout regressions are visible in CI logs.
 */

const fs = require('node:fs');
const assert = require('node:assert/strict');

async function extract(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true }).promise;
  const pages = [];
  for (let index = 1; index <= doc.numPages; index++) {
    const page = await doc.getPage(index);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }
  return pages;
}

(async () => {
  const file = process.argv[2];
  const expectedPages = process.argv[3] ? Number(process.argv[3]) : null;
  if (!file) {
    process.stderr.write('usage: node scripts/pdf-assert.js <file.pdf> [expected-pages]\n');
    process.exit(2);
  }

  const pages = await extract(file);
  if (expectedPages !== null) assert.equal(pages.length, expectedPages, 'page count');

  for (let index = 0; index < pages.length; index++) {
    const text = pages[index];
    assert.ok(text.length > 0, `page ${index + 1} has no extractable text`);
    if (pages.length > 1) {
      // Letter-spaced uppercase footers extract as "PA G E 1 O F 2".
      const squished = text.toLowerCase().replace(/\s+/g, "");
      assert.ok(
        squished.includes(`page${index + 1}of${pages.length}`),
        `footer numbering on page ${index + 1}`
      );
    }
  }

  process.stdout.write(
    `pdf ok: ${pages.length} page(s), extractable text, footer numbering present\n`
  );
  process.stdout.write(`  p1: ${pages[0].slice(0, 140)}…\n`);
})().catch((error) => {
  process.stderr.write(`pdf assertion failed: ${error.message}\n`);
  process.exit(1);
});
