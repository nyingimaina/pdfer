'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const LF = '\n';

/** Strip BOM and normalise CRLF/CR to LF. SPEC v1.1 N5. */
function normalizeText(text) {
  if (typeof text !== 'string') return text;
  let out = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  out = out.replace(/\r\n?/g, LF);
  return out.normalize('NFC');
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function sha256Tag(data) {
  return 'sha256:' + sha256(data);
}

/** Deterministic JSON: sorted keys, no whitespace. */
function canonicalJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

const TENANT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const DOCUMENT_TYPE_RE = /^[a-z][a-z0-9-]{1,63}$/;

function assertTenant(tenant) {
  return typeof tenant === 'string' && TENANT_RE.test(tenant) && !/^\d+$/.test(tenant);
}

/**
 * Asset paths are always relative, forward-slashed, and confined to a bundle.
 * Returns the normalised path or null when unsafe (SPEC AB1, AR2).
 */
function safeRelativePath(input) {
  if (typeof input !== 'string' || !input.length || input.length > 512) return null;
  if (input.includes('\\') || input.includes('\0')) return null;
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input) || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) {
    return null;
  }
  if (input.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    // allow a single trailing nothing; reject empty segments and traversal
    return null;
  }
  const normalised = path.posix.normalize(input);
  if (normalised.startsWith('../') || normalised === '..' || normalised.startsWith('/')) return null;
  return normalised;
}

function sanitizeFileName(name, fallback = 'document.pdf') {
  const base = String(name || fallback).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/^\.+/, '').trim();
  const safe = base.slice(0, 180) || fallback;
  return safe.toLowerCase().endsWith('.pdf') || safe.includes('.') ? safe : safe + '.pdf';
}

function randomId(prefix) {
  return prefix + crypto.randomBytes(16).toString('hex');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
  }
  return prev[n];
}

/** Nearest candidate within edit distance 2, else null. */
function suggest(token, candidates) {
  let best = null;
  let bestScore = 3;
  for (const candidate of candidates) {
    const score = levenshtein(token, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Minimal async mutex keyed by string. Process-local by design (single instance). */
class KeyedMutex {
  constructor() {
    this.chains = new Map();
  }

  async run(key, fn) {
    const previous = this.chains.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.chains.set(key, previous.then(() => current));
    try {
      await previous;
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === current) this.chains.delete(key);
      else {
        // Trim completed chains lazily to keep the map bounded.
        const tail = this.chains.get(key);
        if (tail) tail.finally(() => {
          if (this.chains.get(key) === tail) this.chains.delete(key);
        });
      }
    }
  }
}

function parseIsoInstant(value) {
  if (typeof value !== 'string' || !/Z$/.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

function truncate(value, max) {
  const s = String(value);
  return s.length > max ? s.slice(0, max) + '…' : s;
}

module.exports = {
  LF,
  normalizeText,
  sha256,
  sha256Tag,
  canonicalJson,
  sortDeep,
  escapeHtml,
  isPlainObject,
  assertTenant,
  TENANT_RE,
  DOCUMENT_TYPE_RE,
  safeRelativePath,
  sanitizeFileName,
  randomId,
  levenshtein,
  suggest,
  KeyedMutex,
  parseIsoInstant,
  truncate
};
