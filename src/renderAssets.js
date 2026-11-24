'use strict';

const { sha256 } = require('./util');
const { findReferences } = require('./references');

/**
 * Assets are stored and validated under their documented path
 * (`assets/logo.png`), but Gotenberg writes every uploaded file under its base
 * name only — `sanitizeFilename` in Gotenberg's `api/context.go` strips
 * everything up to the last separator, as a path-traversal guard. A template
 * asking for `./assets/logo.png` therefore 404s inside the renderer while the
 * engine reports success.
 *
 * So the copy sent to the renderer is rewritten: every asset gets a flat,
 * content-derived name, the files are uploaded under that name, and the
 * references in the body, header and footer are pointed at it. The compiled
 * HTML, the `/compile` output and the input hash keep the portable
 * `./assets/...` form.
 */

const UNSAFE_NAME_CHARS = /[^A-Za-z0-9._-]+/g;

/** `assets/brand/logo.png` -> `4ea57ce2af96-logo.png` (content-derived). */
function flattenAssets(assets) {
  const flatNames = new Map();

  for (const asset of assets || []) {
    if (!asset || typeof asset.path !== 'string') continue;

    const base = asset.path.split('/').pop() || 'asset';
    const digest = String(asset.sha256 || '')
      .replace(/^sha256:/, '')
      .slice(0, 12) || sha256(asset.bytes || '').slice(0, 12);
    const safe = base.replace(UNSAFE_NAME_CHARS, '_').replace(/^\.+/, '') || 'asset';

    flatNames.set(asset.path, `${digest}-${safe}`);
  }

  return flatNames;
}

/** The asset key a reference points at: no `./`, no leading `/`, decoded. */
function normaliseReference(target) {
  let path = target;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* malformed escape: compare as written */
  }
  return path.replace(/^\.\//, '').replace(/^\//, '');
}

/** Rewrites only the reference targets, leaving every other byte alone. */
function rewriteAssetReferences(source, flatNames) {
  if (!source || !flatNames || flatNames.size === 0) return source;

  const seen = new Set();
  const replacements = [];
  for (const reference of findReferences(source)) {
    const key = `${reference.start}:${reference.end}`;
    if (seen.has(key)) continue; // `@import url(...)` matches two patterns
    seen.add(key);

    const flat = flatNames.get(normaliseReference(reference.target));
    if (flat) replacements.push({ ...reference, value: `./${flat}` });
  }
  if (replacements.length === 0) return source;

  // Right to left, so earlier offsets stay valid.
  replacements.sort((left, right) => right.start - left.start);
  let out = source;
  for (const replacement of replacements) {
    out = out.slice(0, replacement.start) + replacement.value + out.slice(replacement.end);
  }
  return out;
}

/**
 * Everything the renderer needs: rewritten HTML, and the files to upload under
 * their flat names (one per distinct name).
 */
function prepareRenderAssets({ html, assets, headerHtml, footerHtml }) {
  const flatNames = flattenAssets(assets);

  const files = [];
  const sent = new Set();
  for (const asset of assets || []) {
    const name = flatNames.get(asset && asset.path);
    if (!name || sent.has(name)) continue;
    sent.add(name);
    files.push({ name, bytes: asset.bytes, mimeType: asset.mimeType });
  }

  return {
    html: rewriteAssetReferences(html, flatNames),
    headerHtml: headerHtml ? rewriteAssetReferences(headerHtml, flatNames) : headerHtml,
    footerHtml: footerHtml ? rewriteAssetReferences(footerHtml, flatNames) : footerHtml,
    files
  };
}

module.exports = { flattenAssets, rewriteAssetReferences, prepareRenderAssets, normaliseReference };
