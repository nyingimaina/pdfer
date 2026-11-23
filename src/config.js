'use strict';

const path = require('node:path');

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function bool(value, fallback) {
  if (value === undefined) return fallback;
  return value === '1' || value === 'true' || value === 'yes';
}

/**
 * Every setting has a default (SPEC Z-2). Nothing here is required for a
 * working container.
 */
function loadConfig(env = process.env) {
  const isWindows = process.platform === 'win32';
  const embedded = env.GOTENBERG_URL ? false : !isWindows;

  return {
    port: int(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    dataDir: env.PDFER_DATA_DIR || (isWindows ? path.resolve('.pdfer-data') : '/data'),

    authMode: env.PDFER_AUTH_MODE || 'off',
    apiKey: env.PDFER_API_KEY || null,

    renderer: {
      external: !embedded,
      baseUrl: env.GOTENBERG_URL || `http://127.0.0.1:${int(env.PDFER_RENDERER_PORT, 3001)}`,
      port: int(env.PDFER_RENDERER_PORT, 3001),
      bin: env.PDFER_RENDERER_BIN || 'gotenberg',
      startTimeoutMs: int(env.PDFER_RENDERER_START_TIMEOUT_MS, 40000),
      javascriptEnabled: bool(env.PDFER_ALLOW_JAVASCRIPT, false)
    },

    maxConcurrency: int(env.PDFER_MAX_CONCURRENCY, 2),
    maxQueue: int(env.PDFER_MAX_QUEUE, 32),
    renderTimeoutMs: int(env.PDFER_RENDER_TIMEOUT_MS, 60000),
    renderRetries: int(env.PDFER_RENDER_RETRIES, 2),

    maxBodyBytes: int(env.PDFER_MAX_BODY_BYTES, 34603008),
    maxTemplateBytes: int(env.PDFER_MAX_TEMPLATE_BYTES, 2097152),
    maxDataBytes: int(env.PDFER_MAX_DATA_BYTES, 33554432),
    maxAssetBytes: int(env.PDFER_MAX_ASSET_BYTES, 10485760),
    maxBundleBytes: int(env.PDFER_MAX_BUNDLE_BYTES, 67108864),
    maxRows: int(env.PDFER_MAX_ROWS, 50000),
    maxOutputBytes: int(env.PDFER_MAX_OUTPUT_BYTES, 104857600),

    seedDemo: bool(env.PDFER_SEED_DEMO, true),
    schemasFile: env.PDFER_SCHEMAS_FILE || null,
    allowDataUris: bool(env.PDFER_ALLOW_DATA_URIS, false),
    logLevel: env.PDFER_LOG_LEVEL || 'info',
    rateLimitPerMinute: int(env.PDFER_RATE_LIMIT_PER_MINUTE, 0),
    artifactRetentionDays: int(env.PDFER_ARTIFACT_RETENTION_DAYS, 0),
    assertRendererVersion: env.PDFER_ASSERT_RENDERER_VERSION !== 'false'
  };
}

module.exports = { loadConfig };
