'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  flattenAssets,
  rewriteAssetReferences,
  prepareRenderAssets
} = require('../src/renderAssets');

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function asset(path, sha256 = SHA_A, bytes = Buffer.from(path)) {
  return { path, sha256, bytes, mimeType: 'application/octet-stream' };
}

test('flattening keeps the base name and prefixes a content hash', () => {
  const map = flattenAssets([asset('assets/logo.png', SHA_A)]);
  assert.equal(map.get('assets/logo.png'), 'aaaaaaaaaaaa-logo.png');
});

test('flattening removes the directory, so two folders cannot collide', () => {
  const map = flattenAssets([
    asset('assets/brand/logo.png', SHA_A),
    asset('assets/partner/logo.png', SHA_B)
  ]);
  assert.equal(map.get('assets/brand/logo.png'), 'aaaaaaaaaaaa-logo.png');
  assert.equal(map.get('assets/partner/logo.png'), 'bbbbbbbbbbbb-logo.png');
  assert.notEqual(map.get('assets/brand/logo.png'), map.get('assets/partner/logo.png'));
});

test('flattening sanitises characters that would break a URL or an attribute', () => {
  const map = flattenAssets([asset('assets/My Logo #2.png', SHA_A)]);
  assert.equal(map.get('assets/My Logo #2.png'), 'aaaaaaaaaaaa-My_Logo_2.png');
});

test('flattening falls back to hashing the bytes when no digest is given', () => {
  const map = flattenAssets([{ path: 'assets/x.png', bytes: Buffer.from('abc') }]);
  assert.match(map.get('assets/x.png'), /^[0-9a-f]{12}-x\.png$/);
});

test('rewriting covers every reference form the validator recognises', () => {
  const map = new Map([
    ['assets/a.png', 'flat-a.png'],
    ['assets/f.woff2', 'flat-f.woff2'],
    ['assets/bg.png', 'flat-bg.png'],
    ['assets/s.css', 'flat-s.css']
  ]);
  const html = [
    '<img src="./assets/a.png">',
    '<img src="assets/a.png">',
    '<img src="/assets/a.png">',
    "<style>@font-face{src:url(\"./assets/f.woff2\")}</style>",
    '<style>body{background:url(assets/bg.png)}</style>',
    "<style>body{background:url('/assets/bg.png')}</style>",
    '<link rel="stylesheet" href="./assets/s.css">',
    '<style>@import "./assets/s.css";</style>'
  ].join('\n');
  const out = rewriteAssetReferences(html, map);
  assert.doesNotMatch(out, /\.\/assets\//);
  assert.doesNotMatch(out, /url\(assets\//);
  assert.match(out, /<img src="\.\/flat-a\.png">/);
  assert.match(out, /src="\.\/flat-a\.png"/);
  assert.match(out, /url\("\.\/flat-f\.woff2"\)/);
  assert.match(out, /url\(\.\/flat-bg\.png\)/);
  assert.match(out, /url\('\.\/flat-bg\.png'\)/);
  assert.match(out, /href="\.\/flat-s\.css"/);
  assert.match(out, /@import "\.\/flat-s\.css"/);
});

test('rewriting handles @import url(...) without double-splicing', () => {
  const map = new Map([['assets/s.css', 'flat-s.css']]);
  assert.equal(
    rewriteAssetReferences('<style>@import url("./assets/s.css");</style>', map),
    '<style>@import url("./flat-s.css");</style>'
  );
});

test('rewriting matches a percent-encoded reference', () => {
  const map = new Map([['assets/My Logo.png', 'flat-logo.png']]);
  assert.equal(
    rewriteAssetReferences('<img src="./assets/My%20Logo.png">', map),
    '<img src="./flat-logo.png">'
  );
});

test('rewriting leaves text that merely mentions a path alone', () => {
  const map = new Map([['assets/a.png', 'flat-a.png']]);
  const html = '<p>See ./assets/a.png for details</p>';
  assert.equal(rewriteAssetReferences(html, map), html);
});

test('rewriting leaves references it does not know alone', () => {
  const map = new Map([['assets/a.png', 'flat-a.png']]);
  const html = '<img src="./assets/other.png"><img src="data:image/png;base64,AA==">';
  assert.equal(rewriteAssetReferences(html, map), html);
});

test('rewriting is a no-op without assets', () => {
  const html = '<img src="./assets/a.png">';
  assert.equal(rewriteAssetReferences(html, new Map()), html);
  assert.equal(rewriteAssetReferences(html, null), html);
});

test('rewriting preserves the rest of the document byte for byte', () => {
  const map = new Map([['assets/a.png', 'flat-a.png']]);
  const html = '<!doctype html>\n<html><body class="x">\r\n<img src="./assets/a.png">\n</body></html>';
  assert.equal(
    rewriteAssetReferences(html, map),
    '<!doctype html>\n<html><body class="x">\r\n<img src="./flat-a.png">\n</body></html>'
  );
});

test('preparation rewrites the body, the header and the footer', () => {
  const prepared = prepareRenderAssets({
    html: '<img src="./assets/a.png">',
    headerHtml: '<img src="./assets/a.png">',
    footerHtml: '<style>body{background:url("./assets/a.png")}</style>',
    assets: [asset('assets/a.png', SHA_A)]
  });
  assert.equal(prepared.html, '<img src="./aaaaaaaaaaaa-a.png">');
  assert.equal(prepared.headerHtml, '<img src="./aaaaaaaaaaaa-a.png">');
  assert.equal(prepared.footerHtml, '<style>body{background:url("./aaaaaaaaaaaa-a.png")}</style>');
  assert.deepEqual(prepared.files.map((f) => f.name), ['aaaaaaaaaaaa-a.png']);
});

test('preparation sends one file per distinct flat name', () => {
  const prepared = prepareRenderAssets({
    html: '<img src="./assets/a/logo.png"><img src="./assets/b/logo.png">',
    assets: [
      asset('assets/a/logo.png', SHA_A),
      asset('assets/b/logo.png', SHA_A),
      asset('assets/c/other.png', SHA_B)
    ]
  });
  assert.deepEqual(prepared.files.map((f) => f.name).sort(), [
    'aaaaaaaaaaaa-logo.png',
    'bbbbbbbbbbbb-other.png'
  ]);
});

test('preparation leaves absent decorators absent', () => {
  const prepared = prepareRenderAssets({
    html: '<p>hi</p>',
    headerHtml: null,
    footerHtml: undefined,
    assets: []
  });
  assert.equal(prepared.headerHtml, null);
  assert.equal(prepared.footerHtml, undefined);
  assert.deepEqual(prepared.files, []);
});
