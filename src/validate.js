'use strict';

const { EngineError } = require('./errors');
const { analyze, parseOnly } = require('./liquid');
const { buildSampleData } = require('./binder');
const { normalizeText } = require('./util');

/**
 * Produces a ValidationReport (SPEC §5.10 + v1.1). Never throws for a bad
 * template; throws only for a malformed request or an exceeded hard limit.
 */
async function buildReport({
  content,
  schema,
  data,
  binder,
  assetResolver,
  tenant,
  assets = null,
  hasHeaderOrFooter = false,
  allowDataUris = false,
  maxTemplateBytes,
  authoredSchemaVersion = null
}) {
  const normalized = normalizeText(content);
  const byteLength = Buffer.byteLength(normalized || '', 'utf8');
  if (byteLength > maxTemplateBytes) {
    throw new EngineError('TEMPLATE_TOO_LARGE', `Template exceeds ${maxTemplateBytes} bytes`, {
      details: { byteLength, maximum: maxTemplateBytes }
    });
  }

  const warnings = [];
  const schemaMismatches = [];

  if (
    authoredSchemaVersion !== null &&
    authoredSchemaVersion !== undefined &&
    Number(authoredSchemaVersion) !== schema.schemaVersion
  ) {
    schemaMismatches.push({
      code: 'SCHEMA_VERSION_MISMATCH',
      token: null,
      message: `Template was authored against schema v${authoredSchemaVersion}, but v${schema.schemaVersion} is in use`,
      expectedType: `schema v${authoredSchemaVersion}`,
      receivedType: `schema v${schema.schemaVersion}`
    });
  }

  const analysis = analyze(normalized, schema, { hasHeaderOrFooter, allowDataUris });

  const syntaxErrors = [...analysis.syntaxErrors];
  const parseProblem = parseOnly(normalized);
  if (parseProblem) syntaxErrors.push(parseProblem);

  let bindIssues = [];
  try {
    const payload = data === null || data === undefined ? buildSampleData(schema) : data;
    binder.bind(payload, schema);
  } catch (error) {
    if (error instanceof EngineError) {
      bindIssues = error.details?.issues || [
        { code: error.code, token: null, message: error.message }
      ];
    } else {
      throw error;
    }
  }

  const declared = new Set((assets || []).map((asset) => asset.path));
  const missingAssets = [];
  if (assetResolver) {
    for (const ref of analysis.assetRefs) {
      // Existence is checked against the tenant store; this is validation I/O,
      // never part of compile (SPEC §3.3). The request's `assets` list decides
      // where the bundle comes from, not whether the file exists.
      // eslint-disable-next-line no-await-in-loop
      const exists = await assetResolver.has(tenant, ref);
      if (!exists) missingAssets.push({ path: ref, declared: declared.has(ref) });
    }
  }

  const isRenderable =
    syntaxErrors.length === 0 &&
    analysis.unknownTokens.length === 0 &&
    missingAssets.length === 0 &&
    !bindIssues.some((issue) =>
      ['TYPE_MISMATCH', 'UNKNOWN_DATA_KEY', 'REQUIRED_PLACEHOLDER_MISSING', 'PAGINATION_LIMIT_EXCEEDED'].includes(issue.code)
    ) &&
    !schemaMismatches.some((issue) => issue.code === 'SCHEMA_VERSION_MISMATCH');

  return {
    isRenderable,
    schemaVersion: schema.schemaVersion,
    syntaxErrors,
    unknownTokens: analysis.unknownTokens,
    unusedPlaceholders: analysis.unusedPlaceholders,
    missingAssets,
    schemaMismatches: [...schemaMismatches, ...bindIssues],
    warnings: [...warnings, ...analysis.warnings],
    _analysis: analysis
  };
}

/** Public shape: strip internals. */
function publicReport(report) {
  const { _analysis, ...rest } = report;
  return rest;
}

module.exports = { buildReport, publicReport };
