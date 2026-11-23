'use strict';

const { Liquid } = require('liquidjs');
const { EngineError } = require('./errors');
const { suggest } = require('./util');
const { normalizeText } = require('./util');

/**
 * Liquid subset enforcement and static analysis (SPEC v1.1 N7–N11, §3.10).
 *
 * The same package drives the browser editor and the server, so dialect parity
 * is structural rather than a fixture project.
 */

const ALLOWED_TAGS = new Set([
  'for', 'endfor', 'if', 'elsif', 'else', 'endif',
  'unless', 'endunless', 'assign', 'raw', 'endraw', 'comment', 'endcomment'
]);

const ALLOWED_FILTERS = new Set([
  'escape', 'escape_once', 'default', 'upcase', 'downcase', 'capitalize',
  'strip', 'strip_newlines', 'newline_to_br', 'join', 'size', 'first', 'last',
  'truncate', 'append', 'prepend', 'replace'
]);

const KEYWORDS = new Set([
  'and', 'or', 'not', 'contains', 'blank', 'empty', 'nil', 'null', 'true',
  'false', 'in', 'with'
]);

const IDENT_CHAIN_RE = /[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/g;

function createLiquid() {
  const engine = new Liquid({
    strictFilters: true,
    strictVariables: false,
    ownPropertyOnly: true,
    jsTruthy: false,
    cache: false,
    greedy: false
  });

  // Defence in depth: the analyzer rejects these first, but a render must never
  // be able to reach them either.
  for (const name of Object.keys(engine.filters)) {
    if (!ALLOWED_FILTERS.has(name)) {
      engine.filters[name] = () => {
        throw new EngineError('FILTER_NOT_ALLOWED', `Filter '${name}' is not allowed`);
      };
    }
  }

  if (engine.tags && typeof engine.tags.delete === 'function') {
    for (const name of [...engine.tags.keys()]) {
      if (!ALLOWED_TAGS.has(name)) engine.tags.delete(name);
    }
  }

  return engine;
}

const sharedEngine = createLiquid();

function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function positionOf(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

/** Scans raw template text into output/tag tokens with line/column. */
function scanTokens(source) {
  const starts = lineStarts(source);
  const tokens = [];
  const errors = [];
  let cursor = 0;

  const findClose = (from, closeSeq) => {
    const idx = source.indexOf(closeSeq, from);
    return idx;
  };

  while (cursor < source.length) {
    const outIdx = source.indexOf('{{', cursor);
    const tagIdx = source.indexOf('{%', cursor);
    let open = -1;
    let kind = null;
    if (outIdx >= 0 && (tagIdx < 0 || outIdx < tagIdx)) {
      open = outIdx;
      kind = 'output';
    } else if (tagIdx >= 0) {
      open = tagIdx;
      kind = 'tag';
    }
    if (open < 0) break;

    const closeSeq = kind === 'output' ? '}}' : '%}';
    const close = findClose(open + 2, closeSeq);
    if (close < 0) {
      errors.push({
        code: kind === 'output' ? 'UNCLOSED_OUTPUT' : 'UNCLOSED_TAG',
        message: `Unclosed ${kind === 'output' ? 'output tag' : 'tag'}`,
        location: positionOf(starts, open)
      });
      break;
    }

    const inner = source.slice(open + 2, close);
    const token = {
      kind,
      inner,
      start: open,
      end: close + 2,
      ...positionOf(starts, open)
    };
    tokens.push(token);

    if (kind === 'tag') {
      const name = (inner.replace(/^[-~]/, '').trim().split(/\s+/)[0] || '').toLowerCase();
      if (name === 'raw' || name === 'comment') {
        const endRe = new RegExp(`\\{%-?\\s*end${name}\\s*-?%\\}`, 'g');
        endRe.lastIndex = close + 2;
        const endMatch = endRe.exec(source);
        if (!endMatch) {
          errors.push({
            code: 'UNCLOSED_SECTION',
            message: `Section '${name}' opened at line ${token.line} is not closed`,
            location: { line: token.line, column: token.column }
          });
          break;
        }
        tokens.push({
          kind: 'tag',
          inner: `end${name}`,
          start: endMatch.index,
          end: endMatch.index + endMatch[0].length,
          ...positionOf(starts, endMatch.index)
        });
        cursor = endMatch.index + endMatch[0].length;
        continue;
      }
    }

    cursor = close + 2;
  }

  return { tokens, errors, starts };
}

function stripStrings(expression) {
  return expression.replace(/'[^']*'|"[^"]*"/g, "''");
}

function splitFilters(expression) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const ch of expression) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

function resolveChain(chain, schema, scope, { allowCollection = false } = {}) {
  const parts = chain.split('.');
  const root = parts[0];

  if (root === 'forloop' || root === 'empty' || root === 'blank') {
    return { ok: true, node: null };
  }
  if (scope.locals.has(root)) return { ok: true, node: null };

  const loop = scope.loops.length ? scope.loops[scope.loops.length - 1] : null;
  let node = null;
  let candidates = [];
  let opened = false;

  if (loop && loop.varName === root) {
    node = loop.node;
    opened = true;
  } else if (schema.reservedTokens.has(root)) {
    return { ok: true, node: null };
  } else {
    node = schema.root.find((n) => n.name === root) || null;
    candidates = schema.rootTokens;
    if (!node) {
      if (schema.loopVariables.has(root)) {
        const collection = schema.loopVariables.get(root);
        return {
          ok: false,
          token: chain,
          candidates: [],
          message: `'${root}' is a loop variable for '${collection.token}'; use it inside {% for ${root} in ${collection.token} %}`
        };
      }
      // A child of an enclosing loop is only addressable through its loop variable.
      for (const open of scope.loops) {
        const nested = open.node.children.find((c) => c.name === root);
        if (nested) {
          return {
            ok: false,
            token: chain,
            candidates: [open.varName],
            message: `'${root}' is a member of '${open.varName}'; use '${open.varName}.${root}' inside the loop`
          };
        }
      }
      return { ok: false, token: chain, candidates };
    }
  }

  for (const part of parts.slice(1)) {
    if (node.isCollection && !opened) {
      return {
        ok: false,
        token: chain,
        candidates: [node.loopVariable].filter(Boolean),
        message: `'${node.name}' is a collection; iterate it with {% for ${node.loopVariable || 'row'} in ${node.token} %}`
      };
    }
    if (!node.children || !node.children.length) {
      return { ok: false, token: chain, candidates: node.children ? node.children.map((c) => c.name) : [] };
    }
    const next = node.children.find((c) => c.name === part);
    if (!next) {
      return {
        ok: false,
        token: chain,
        candidates: node.children.map((c) => c.name)
      };
    }
    node = next;
    opened = false;
  }

  if (node && node.isCollection && !allowCollection) {
    return {
      ok: false,
      token: chain,
      candidates: [node.loopVariable].filter(Boolean),
      message: `'${chain}' is a collection; iterate it with {% for ${node.loopVariable || 'row'} in ${chain} %}`
    };
  }
  return { ok: true, node };
}

/**
 * Static analysis: tag/filter allow-lists, unknown tokens with suggestions,
 * asset references, unsafe markup, and page-number warnings.
 */
function analyze(sourceInput, schema, options = {}) {
  const source = normalizeText(sourceInput);
  const { tokens, errors: scanErrors, starts } = scanTokens(source);

  const syntaxErrors = [...scanErrors];
  const unknownTokens = [];
  const warnings = [];
  const referenced = new Set();
  const scope = { locals: new Set(), loops: [] };
  const allowDataUris = Boolean(options.allowDataUris);

  const locAt = (token, offsetInInner) => ({
    line: token.line,
    column: token.column + 2 + (offsetInInner || 0)
  });

  const recordUnknown = (token, chain, candidates, offset, message) => {
    const suggestion = candidates && candidates.length ? suggest(chain.split('.')[0], candidates) : null;
    unknownTokens.push({
      token: chain,
      location: locAt(token, offset),
      ...(suggestion ? { suggestion } : {}),
      ...(message ? { message } : {})
    });
  };

  const analyzeExpression = (token, expression, { isCondition = false } = {}) => {
    const segments = splitFilters(expression);
    segments.forEach((segment, index) => {
      let body = segment.trim();
      if (!body) return;
      if (index > 0) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::([\s\S]*))?$/.exec(body);
        if (!match) return;
        const filterName = match[1];
        if (!ALLOWED_FILTERS.has(filterName)) {
          syntaxErrors.push({
            code: 'FILTER_NOT_ALLOWED',
            message: `Filter '${filterName}' is not allowed`,
            location: locAt(token, token.inner.indexOf(filterName))
          });
        }
        body = match[2] || '';
        if (!body) return;
      }

      const stripped = stripStrings(body);
      if (/\[[^\]]*\]/.test(stripped) || /(^|[^.\w])\.\.(?!\.)/.test(stripped)) {
        syntaxErrors.push({
          code: 'TEMPLATE_SYNTAX_ERROR',
          message: 'Bracket and range access are not supported; declare the path in the schema',
          location: locAt(token, 0)
        });
      }
      if (isCondition && /[<>]=?|\b(and|or|contains)\b/.test(stripped)) {
        // Comparison operators are fine; identifiers still need resolution.
      }

      IDENT_CHAIN_RE.lastIndex = 0;
      let match;
      while ((match = IDENT_CHAIN_RE.exec(stripped))) {
        const chain = match[0];
        const root = chain.split('.')[0];
        if (KEYWORDS.has(root)) continue;
        const offset = body.indexOf(chain);
        const resolution = resolveChain(chain, schema, scope, { allowCollection: isCondition });
        if (resolution.ok) {
          referenced.add(chain);
          if (resolution.node && resolution.node.isCollection && !isCondition) {
            // Iterating a collection directly in output is legal but rarely intended.
          }
        } else if (resolution.message) {
          syntaxErrors.push({
            code: 'TYPE_MISMATCH',
            message: resolution.message,
            location: locAt(token, Math.max(offset, 0))
          });
        } else {
          recordUnknown(token, chain, resolution.candidates, Math.max(offset, 0));
        }
      }
    });
  };

  for (const token of tokens) {
    if (token.kind === 'output') {
      analyzeExpression(token, token.inner.replace(/^[-~]/, '').replace(/[-~]$/, ''));
      continue;
    }

    const body = token.inner.replace(/^[-~]/, '').replace(/[-~]$/, '').trim();
    const nameMatch = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
    const name = nameMatch ? nameMatch[1].toLowerCase() : '';
    const rest = nameMatch ? body.slice(nameMatch[0].length).trim() : '';

    if (!ALLOWED_TAGS.has(name)) {
      syntaxErrors.push({
        code: 'TAG_NOT_ALLOWED',
        message: name
          ? `Tag '${name}' is not allowed`
          : 'Empty or malformed tag',
        location: { line: token.line, column: token.column }
      });
      continue;
    }

    switch (name) {
      case 'for': {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+([\s\S]+)$/.exec(rest);
        if (!match) {
          syntaxErrors.push({
            code: 'TEMPLATE_SYNTAX_ERROR',
            message: "Expected 'for <var> in <collection>'",
            location: { line: token.line, column: token.column }
          });
          break;
        }
        const varName = match[1];
        let sourceExpr = match[2].trim();
        sourceExpr = sourceExpr.replace(/\s+(limit|offset)\s*:\s*\S+/g, '').replace(/\s+reversed\s*$/, '').trim();
        analyzeExpression(token, sourceExpr, { isCondition: true });
        const resolution = resolveChain(sourceExpr, schema, scope, { allowCollection: true });
        if (resolution.ok && resolution.node && !resolution.node.isCollection) {
          syntaxErrors.push({
            code: 'TYPE_MISMATCH',
            message: `'${sourceExpr}' is not a collection and cannot be iterated`,
            location: { line: token.line, column: token.column }
          });
        }
        if (!resolution.ok && resolution.message) {
          syntaxErrors.push({
            code: 'TYPE_MISMATCH',
            message: resolution.message,
            location: { line: token.line, column: token.column }
          });
        }
        scope.loops.push({
          varName,
          node: resolution.node || {
            children: [],
            isCollection: true,
            name: varName,
            token: sourceExpr,
            loopVariable: varName
          }
        });
        break;
      }
      case 'endfor':
        scope.loops.pop();
        break;
      case 'if':
      case 'elsif':
      case 'unless':
        analyzeExpression(token, rest, { isCondition: true });
        break;
      case 'assign': {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]+)$/.exec(rest);
        if (!match) {
          syntaxErrors.push({
            code: 'TEMPLATE_SYNTAX_ERROR',
            message: "Expected 'assign <name> = <expression>'",
            location: { line: token.line, column: token.column }
          });
          break;
        }
        analyzeExpression(token, match[2], { isCondition: true });
        scope.locals.add(match[1]);
        break;
      }
      default:
        break;
    }
  }

  if (scope.loops.length) {
    syntaxErrors.push({
      code: 'UNCLOSED_SECTION',
      message: `Section 'for' opened at line ${tokens.find((t) => /^\s*for\s/.test(t.inner))?.line || 1} is not closed`,
      location: { line: tokens[0] ? tokens[0].line : 1, column: 1 }
    });
  }

  // --- markup and reference safety -------------------------------------------
  const markupRules = [
    { re: /<\s*(script|iframe|object|embed|base|form)\b/gi, why: 'Active content is not allowed in templates' },
    { re: /\son[a-z]+\s*=/gi, why: 'Inline event handlers are not allowed' },
    { re: /\b(javascript|vbscript)\s*:/gi, why: 'Script URLs are not allowed' },
    { re: /\bsrcdoc\s*=/gi, why: 'srcdoc is not allowed' }
  ];
  for (const rule of markupRules) {
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(source))) {
      constraintsPush(syntaxErrors, {
        code: 'UNSAFE_MARKUP',
        message: rule.why,
        location: positionOf(starts, m.index)
      });
    }
  }

  const referencePatterns = [
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
    /@import\s+(?:url\(\s*['"]?)?(['"]?)([^'")\s;]+)\1/gi,
    /\bsrc\s*=\s*(['"]?)([^'"\s>]+)\1/gi,
    /\bhref\s*=\s*(['"]?)([^'"\s>]+)\1/gi
  ];
  const assetRefs = new Set();
  for (const re of referencePatterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source))) {
      const target = (m[2] || '').trim();
      if (!target || target.startsWith('#')) continue;
      if (target.startsWith('data:')) {
        if (!allowDataUris) {
          constraintsPush(syntaxErrors, {
            code: 'EXTERNAL_REFERENCE_REJECTED',
            message: 'data: URIs are disabled (PDFER_ALLOW_DATA_URIS=false)',
            location: positionOf(starts, m.index)
          });
        }
        continue;
      }
      if (isExternalReference(target)) {
        constraintsPush(syntaxErrors, {
          code: 'EXTERNAL_REFERENCE_REJECTED',
          message: `External reference '${target}' is not allowed; declare it in the asset bundle`,
          location: positionOf(starts, m.index)
        });
        continue;
      }
      assetRefs.add(target.replace(/^\.\//, ''));
    }
  }

  if (/counter\(\s*(page|pages)\s*\)|class\s*=\s*["'][^"']*\b(totalPages|pageNumber)\b/i.test(source)) {
    warnings.push({
      code: 'HARDCODED_PAGE_NUMBER',
      message: 'Page numbering must be produced by the footer template, not the main template',
      location: positionOf(starts, 0)
    });
  }
  if (options.hasHeaderOrFooter && /@page\s*\{[^}]*margin\s*:\s*0/i.test(source)) {
    warnings.push({
      code: 'HEADER_FOOTER_MARGIN_MISSING',
      message: 'Header/footer supplied with @page margin 0 — content will be clipped unless margins are set',
      location: positionOf(starts, 0)
    });
  }

  const declaredTokens = new Set([...schema.byToken.keys()]);
  const unusedPlaceholders = [...declaredTokens]
    .filter((token) => !referenced.has(token))
    .map((token) => ({ token }));

  const deduped = [];
  const seenDiagnostics = new Set();
  for (const diagnostic of syntaxErrors) {
    const key = `${diagnostic.code}|${diagnostic.message}|${diagnostic.location?.line}:${diagnostic.location?.column}`;
    if (seenDiagnostics.has(key)) continue;
    seenDiagnostics.add(key);
    deduped.push(diagnostic);
  }

  return {
    source,
    syntaxErrors: deduped,
    unknownTokens,
    unusedPlaceholders,
    warnings,
    assetRefs: [...assetRefs],
    referenced,
    hasFatal: syntaxErrors.length > 0 || unknownTokens.length > 0
  };
}

const MAX_CONSTRAINT_HITS = 50;

function constraintsPush(list, item) {
  if (list.length < MAX_CONSTRAINT_HITS) list.push(item);
}

function isExternalReference(target) {
  if (!target) return false;
  if (target.startsWith('//')) return true;
  if (target.startsWith('/')) return true;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return true;
  if (target.includes('\\')) return true;
  if (target.split('/').some((part) => part === '..')) return true;
  return false;
}

function extractSyntaxError(error, source) {
  const token = error && (error.token || error.context);
  let line = token && token.line;
  let column = token && (token.col || token.column);
  if (!line && error && typeof error.message === 'string') {
    const m = /line:(\d+)/.exec(error.message);
    if (m) line = Number(m[1]);
  }
  if (!line) {
    line = 1;
    column = column || 1;
  }
  return {
    code: 'TEMPLATE_SYNTAX_ERROR',
    message: String(error && error.message ? error.message : error),
    location: { line: Number(line) || 1, column: Number(column) || 1 }
  };
}

/** Compiles normalized source against a model. Pure: no I/O, no clock. */
function compileText(source, model) {
  try {
    return sharedEngine.parseAndRenderSync(normalizeText(source), model);
  } catch (error) {
    if (error instanceof EngineError) throw error;
    const detail = extractSyntaxError(error, source);
    throw new EngineError('TEMPLATE_SYNTAX_ERROR', detail.message, { location: detail.location });
  }
}

function parseOnly(source) {
  try {
    sharedEngine.parse(normalizeText(source));
    return null;
  } catch (error) {
    if (error instanceof EngineError) return { code: error.code, message: error.message };
    return extractSyntaxError(error, source);
  }
}

module.exports = {
  createLiquid,
  analyze,
  compileText,
  parseOnly,
  scanTokens,
  ALLOWED_TAGS,
  ALLOWED_FILTERS,
  sharedEngine
};
