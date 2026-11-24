'use strict';

/**
 * The reference forms a template may use to point at a bundled asset.
 *
 * One list, shared by the validator (`analyze` in `liquid.js`) and by the
 * renderer's rewrite step, so the two cannot disagree about what counts as a
 * reference. Group 2 is always the target; the `d` flag exposes its offsets so
 * the rewrite can splice in place instead of searching for the text again.
 *
 * Deliberately not covered: `srcset`, `poster`, and `url()` inside a linked
 * stylesheet. The validator never extracted those, so nothing is bundled for
 * them; the renderer now fails loudly instead of dropping them silently.
 */
const REFERENCE_PATTERNS = [
  /url\(\s*(['"]?)([^'")]+)\1\s*\)/gid,
  /@import\s+(?:url\(\s*['"]?)?(['"]?)([^'")\s;]+)\1/gid,
  /\bsrc\s*=\s*(['"]?)([^'"\s>]+)\1/gid,
  /\bhref\s*=\s*(['"]?)([^'"\s>]+)\1/gid
];

/**
 * Every reference in `source`, with the exact offsets of its target.
 *
 * The same target can be reported twice (an `@import url(...)` matches both the
 * `@import` and the `url()` pattern); callers that mutate by offset must
 * de-duplicate.
 */
function findReferences(source) {
  const found = [];
  if (typeof source !== 'string' || source.length === 0) return found;

  for (const pattern of REFERENCE_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(source))) {
      const raw = match[2] || '';
      const target = raw.trim();
      if (!target || target.startsWith('#')) continue;

      const lead = raw.length - raw.trimStart().length;
      const start = match.indices[2][0] + lead;
      found.push({ target, start, end: start + target.length });
    }
  }

  return found;
}

module.exports = { REFERENCE_PATTERNS, findReferences };
