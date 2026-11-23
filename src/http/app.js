'use strict';

const crypto = require('node:crypto');
const Fastify = require('fastify');
const { EngineError, isEngineError } = require('../errors');
const { randomId, safeRelativePath } = require('../util');

const API_VERSION = '1.1';
const ENGINE_VERSION = require('../../package.json').version;

const DURATION_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];

const METRICS = {
  renders: { ok: 0, failed: 0 },
  previews: { ok: 0, failed: 0 },
  validations: 0,
  artifactsSaved: 0,
  artifactsRemoved: 0,
  rateLimited: 0,
  durations: {
    buckets: DURATION_BUCKETS,
    counts: DURATION_BUCKETS.map(() => 0),
    sum: 0,
    count: 0
  }
};

function observeDuration(seconds) {
  const histogram = METRICS.durations;
  histogram.sum += seconds;
  histogram.count += 1;
  for (let index = 0; index < histogram.buckets.length; index++) {
    if (seconds <= histogram.buckets[index]) {
      histogram.counts[index] += 1;
      return;
    }
  }
}

function metricBlock(name, help, type, samples) {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...samples];
}

function metricsText(renderer) {
  const histogram = METRICS.durations;
  const lines = [
    ...metricBlock('pdfer_renders_total', 'Renders by outcome', 'counter', [
      `pdfer_renders_total{outcome="ok"} ${METRICS.renders.ok}`,
      `pdfer_renders_total{outcome="failed"} ${METRICS.renders.failed}`
    ]),
    ...metricBlock('pdfer_previews_total', 'Previews by outcome', 'counter', [
      `pdfer_previews_total{outcome="ok"} ${METRICS.previews.ok}`,
      `pdfer_previews_total{outcome="failed"} ${METRICS.previews.failed}`
    ]),
    ...metricBlock('pdfer_validations_total', 'Validation calls', 'counter', [
      `pdfer_validations_total ${METRICS.validations}`
    ]),
    ...metricBlock('pdfer_artifacts_saved_total', 'Artifacts written', 'counter', [
      `pdfer_artifacts_saved_total ${METRICS.artifactsSaved}`
    ]),
    ...metricBlock('pdfer_artifacts_removed_total', 'Artifacts removed by retention', 'counter', [
      `pdfer_artifacts_removed_total ${METRICS.artifactsRemoved}`
    ]),
    ...metricBlock('pdfer_rate_limited_total', 'Requests rejected by the rate limiter', 'counter', [
      `pdfer_rate_limited_total ${METRICS.rateLimited}`
    ]),
    ...metricBlock('pdfer_render_duration_seconds', 'End-to-end render duration', 'histogram', [
      ...histogram.counts.map(
        (count, index) =>
          `pdfer_render_duration_seconds_bucket{le="${histogram.buckets[index]}"} ${count}`
      ),
      `pdfer_render_duration_seconds_bucket{le="+Inf"} ${histogram.count}`,
      `pdfer_render_duration_seconds_sum ${histogram.sum.toFixed(6)}`,
      `pdfer_render_duration_seconds_count ${histogram.count}`
    ])
  ];

  if (renderer) {
    lines.push(
      ...metricBlock('pdfer_render_queue_depth', 'Renders waiting for a slot', 'gauge', [
        `pdfer_render_queue_depth ${renderer.queueDepth ?? 0}`
      ]),
      ...metricBlock('pdfer_render_active', 'Renders in flight', 'gauge', [
        `pdfer_render_active ${renderer.activeRenders ?? 0}`
      ])
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Optional fixed-window limiter (SPEC §13.6). Off by default: the engine is
 * normally reached only through a trusted backend, which owns per-user quotas.
 */
class FixedWindowLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.windows = new Map();
  }

  allow(key) {
    if (!this.limit) return true;
    const bucket = Math.floor(Date.now() / this.windowMs);
    const entry = this.windows.get(key);
    if (!entry || entry.bucket !== bucket) {
      this.windows.set(key, { bucket, count: 1 });
      if (this.windows.size > 10000) {
        for (const [existing, value] of this.windows) {
          if (value.bucket !== bucket) this.windows.delete(existing);
        }
      }
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}

function timingSafeEquals(candidate, expected) {
  const left = Buffer.from(String(candidate ?? ''), 'utf8');
  const right = Buffer.from(String(expected ?? ''), 'utf8');
  if (left.length !== right.length) {
    crypto.timingSafeEqual(right, right);
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function buildApp({ engine, config, rendererProcess, logger, registry }) {
  const app = Fastify({
    logger: false,
    bodyLimit: config.maxBodyBytes,
    genReqId: () => randomId('req_'),
    disableRequestLogging: true
  });

  const jobs = new Map();

  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('cache-control', 'no-store');
    return payload;
  });

  const limiter = new FixedWindowLimiter({
    limit: config.rateLimitPerMinute,
    windowMs: 60000
  });

  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0];
    const open =
      path === '/healthz' ||
      path === '/readyz' ||
      path === '/' ||
      path === '/version' ||
      path === '/metrics';

    if (!open && !limiter.allow(request.ip)) {
      METRICS.rateLimited += 1;
      throw new EngineError('RATE_LIMITED', 'Too many requests; retry shortly', {
        details: { limitPerMinute: config.rateLimitPerMinute }
      });
    }

    if (config.authMode === 'apikey' && !open) {
      const header = request.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!config.apiKey || !timingSafeEquals(token, config.apiKey)) {
        throw new EngineError('UNAUTHORIZED', 'A valid API key is required');
      }
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (isEngineError(error)) {
      if (error.status >= 500) {
        logger.error({ err: error.message, code: error.code, requestId: request.id }, 'request failed');
      }
      return reply.code(error.status).send(error.toEnvelope(request.id));
    }
    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.code === 'FST_ERR_CTP_INVALID_SIZE') {
      const tooLarge = new EngineError('REQUEST_TOO_LARGE', 'Request body exceeds the configured limit');
      return reply.code(413).send(tooLarge.toEnvelope(request.id));
    }
    if (typeof error.code === 'string' && error.code.startsWith('FST_ERR_CTP')) {
      const malformed = new EngineError('REQUEST_INVALID', 'Malformed or unparseable request body');
      return reply.code(422).send(malformed.toEnvelope(request.id));
    }
    if (error.statusCode === 400) {
      const malformed = new EngineError('REQUEST_INVALID', error.message || 'Malformed request');
      return reply.code(422).send(malformed.toEnvelope(request.id));
    }
    logger.error({ err: error.message, stack: error.stack, requestId: request.id }, 'unhandled error');
    const internal = new EngineError('INTERNAL_ERROR', 'Unexpected error');
    return reply.code(500).send(internal.toEnvelope(request.id));
  });

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      error: {
        code: 'REQUEST_INVALID',
        message: `No route for ${request.method} ${request.url.split('?')[0]}`,
        retriable: false,
        details: { requestId: request.id }
      }
    });
  });

  // ---------------------------------------------------------------- landing

  app.get('/', async (_request, reply) => {
    reply.type('text/html; charset=utf-8').send(landingPage());
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_request, reply) => {
    // A renderer stopped on purpose is still "ready": the next render starts it.
    if (rendererProcess && typeof rendererProcess.isIdle === 'function' && rendererProcess.isIdle()) {
      return { status: 'ready', renderer: { status: 'idle', version: null } };
    }
    const health = await engine.renderer.health();
    const ready = health.ok && (!rendererProcess || rendererProcess.isReady());
    if (!ready) {
      reply.code(503);
      return {
        status: 'unavailable',
        renderer: health,
        error: { code: 'RENDERER_UNAVAILABLE', retriable: true }
      };
    }
    return { status: 'ready', renderer: health };
  });

  app.get('/version', async () => ({
    engine: ENGINE_VERSION,
    api: API_VERSION,
    node: process.version,
    renderer: {
      mode: config.renderer.external ? 'external' : 'embedded',
      version: (await engine.renderer.health()).version
    }
  }));

  app.get('/metrics', async (_request, reply) => {
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(metricsText(engine.renderer));
  });

  // --------------------------------------------------------------- catalogue

  const catalogue = async (path, handler) => {
    app.get(path, handler);
    app.get(path.replace('/v1', ''), handler);
  };
  const operation = async (path, handler) => {
    app.post(path, handler);
    app.post(path.replace('/v1', ''), handler);
  };

  catalogue('/v1/document-types', async (request) => {
    return engine.listDocumentTypes(requireTenantQuery(request));
  });

  catalogue('/v1/document-types/:key/placeholders', async (request) => {
    const version = request.query.version ? Number(request.query.version) : undefined;
    return engine.getPlaceholderSchema(request.params.key, version);
  });

  catalogue('/v1/document-types/:key/sample-data', async (request) => {
    const version = request.query.version ? Number(request.query.version) : undefined;
    return engine.getSampleData(request.params.key, version);
  });

  // --------------------------------------------------------------- templates

  app.get('/v1/templates', async (request) => {
    const { tenant, documentType, state, limit, cursor } = request.query;
    return engine.listTemplates(tenant, { documentType, state, limit, cursor });
  });
  app.get('/templates', async (request) => {
    const { tenant, documentType, state, limit, cursor } = request.query;
    return engine.listTemplates(tenant, { documentType, state, limit, cursor });
  });

  operation('/v1/templates', async (request) => {
    const result = await engine.saveTemplate(request.body);
    return {
      templateId: result.templateId,
      version: result.version,
      checksum: result.checksum,
      schemaVersion: result.schemaVersion
    };
  });

  app.get('/v1/templates/:templateId', async (request) => {
    const { version, tenant } = request.query;
    const record = await engine.getTemplate(
      { templateId: request.params.templateId, version: Number(version) },
      tenant
    );
    return record;
  });
  app.get('/templates/:templateId', async (request) => {
    const { version, tenant } = request.query;
    return engine.getTemplate(
      { templateId: request.params.templateId, version: Number(version) },
      tenant
    );
  });

  const transition = (action) => async (request, reply) => {
    const tenant = requireTenantQuery(request);
    const ref = {
      templateId: request.params.templateId,
      version: Number(request.params.version)
    };
    if (!Number.isInteger(ref.version) || ref.version < 1) {
      throw new EngineError('REQUEST_INVALID', '`version` must be a positive integer');
    }
    if (action === 'publish') await engine.publishTemplate(ref, tenant);
    if (action === 'default') await engine.setDefaultTemplate(ref, tenant);
    if (action === 'retire') await engine.retireTemplate(ref, tenant);
    reply.code(204).send();
    return reply;
  };

  for (const action of ['publish', 'default', 'retire']) {
    app.post(`/v1/templates/:templateId/versions/:version/${action}`, transition(action));
    app.post(`/templates/:templateId/versions/:version/${action}`, transition(action));
  }

  // ------------------------------------------------------------ engine calls

  operation('/v1/validate', async (request) => {
    METRICS.validations += 1;
    return engine.validate(request.body);
  });

  operation('/v1/compile', async (request, reply) => {
    const result = await engine.compile({ ...request.body, mode: 'preview' });
    reply
      .type('text/html; charset=utf-8')
      .header('x-schema-version', String(result.schemaVersion))
      .header('x-input-hash', result.provenance.inputHash);
    return result.html;
  });

  operation('/v1/preview', async (request, reply) => {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await engine.preview({ ...request.body, mode: 'preview' });
      METRICS.previews.ok += 1;
      applyProvenance(reply, result.artifact);
      reply.type(result.artifact.contentType);
      return result.bytes;
    } catch (error) {
      METRICS.previews.failed += 1;
      throw error;
    } finally {
      observeDuration(Number(process.hrtime.bigint() - startedAt) / 1e9);
    }
  });

  operation('/v1/render', async (request, reply) => {
    const preferAsync =
      String(request.headers.prefer || '').includes('respond-async') ||
      String(request.query.async || '') === 'true';

    if (preferAsync) {
      if ((request.body && request.body.mode) === 'preview') {
        throw new EngineError('REQUEST_INVALID', 'Async rendering is only available in production mode');
      }
      const jobId = randomId('job_');
      const job = { id: jobId, status: 'running', createdAt: Date.now() };
      jobs.set(jobId, job);
      const jobStartedAt = process.hrtime.bigint();
      engine
        .render(request.body, {})
        .then(({ artifact }) => {
          job.status = 'done';
          job.handle = artifact.handle;
          job.artifact = artifact;
          METRICS.renders.ok += 1;
          if (artifact.handle) METRICS.artifactsSaved += 1;
        })
        .catch((error) => {
          job.status = 'failed';
          job.error = isEngineError(error)
            ? { code: error.code, message: error.message, retriable: error.retriable }
            : { code: 'INTERNAL_ERROR', message: 'Unexpected error', retriable: true };
          METRICS.renders.failed += 1;
        })
        .finally(() => {
          observeDuration(Number(process.hrtime.bigint() - jobStartedAt) / 1e9);
          pruneJobs(jobs);
        });
      reply.code(202).header('location', `/v1/jobs/${jobId}`);
      return { jobId, status: 'running' };
    }

    const startedAt = process.hrtime.bigint();
    try {
      const { artifact, bytes } = await engine.render(request.body);
      METRICS.renders.ok += 1;
      if (artifact.handle) METRICS.artifactsSaved += 1;
      applyProvenance(reply, artifact);
      reply.type(artifact.contentType);
      if (artifact.fileName && artifact.contentType === 'application/pdf') {
        reply.header('content-disposition', `inline; filename="${artifact.fileName}"`);
      }
      return bytes;
    } catch (error) {
      METRICS.renders.failed += 1;
      throw error;
    } finally {
      observeDuration(Number(process.hrtime.bigint() - startedAt) / 1e9);
    }
  });

  // ------------------------------------------------------------------- jobs

  app.get('/v1/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) throw new EngineError('JOB_NOT_FOUND', 'Unknown job');
    if (job.status === 'running') {
      reply.code(202);
      return { jobId: job.id, status: 'running' };
    }
    if (job.status === 'failed') {
      reply.code(job.error.code === 'RENDER_TIMEOUT' ? 504 : job.error.code === 'RENDERER_UNAVAILABLE' ? 503 : 400);
      return { error: { ...job.error, details: { requestId: request.id } } };
    }
    const tenant = request.query.tenant;
    reply.code(303).header('location', `/v1/artifacts/${job.handle}?tenant=${encodeURIComponent(tenant || '')}`);
    return { jobId: job.id, status: 'done', handle: job.handle, artifact: job.artifact };
  });
  app.get('/jobs/:id', async (request, reply) => {
    const job = jobs.get(request.params.id);
    if (!job) throw new EngineError('JOB_NOT_FOUND', 'Unknown job');
    if (job.status === 'running') {
      reply.code(202);
      return { jobId: job.id, status: 'running' };
    }
    if (job.status === 'failed') {
      reply.code(job.error.code === 'RENDER_TIMEOUT' ? 504 : job.error.code === 'RENDERER_UNAVAILABLE' ? 503 : 400);
      return { error: { ...job.error, details: { requestId: request.id } } };
    }
    const tenant = request.query.tenant || '';
    reply.code(303).header('location', `/artifacts/${job.handle}?tenant=${encodeURIComponent(tenant)}`);
    return { jobId: job.id, status: 'done', handle: job.handle, artifact: job.artifact };
  });

  // -------------------------------------------------------------- artifacts

  app.get('/v1/artifacts/:handle', async (request, reply) => {
    const tenant = requireTenantQuery(request);
    const { meta, stream } = await engine.outputStore.open(request.params.handle, tenant);
    reply
      .type('application/pdf')
      .header('content-length', String(meta.byteLength))
      .header('content-disposition', `inline; filename="${meta.fileName}"`);
    return stream;
  });
  app.get('/artifacts/:handle', async (request, reply) => {
    const tenant = requireTenantQuery(request);
    const { meta, stream } = await engine.outputStore.open(request.params.handle, tenant);
    reply
      .type('application/pdf')
      .header('content-length', String(meta.byteLength))
      .header('content-disposition', `inline; filename="${meta.fileName}"`);
    return stream;
  });

  // ----------------------------------------------------------------- assets

  app.put('/v1/assets/*', async (request) => {
    const tenant = requireTenantQuery(request);
    const assetPath = request.params['*'];
    const normalised = safeRelativePath(assetPath);
    if (!normalised) throw new EngineError('ASSET_REJECTED', `Unsafe asset path '${assetPath}'`);
    if (!Buffer.isBuffer(request.body)) {
      throw new EngineError('REQUEST_INVALID', 'Asset uploads must be sent as a raw binary body');
    }
    const meta = await engine.assetResolver.register(tenant, {
      path: normalised,
      bytes: request.body,
      mimeType: request.headers['content-type'] || 'application/octet-stream'
    });
    return meta;
  });
  app.put('/assets/*', async (request) => {
    const tenant = requireTenantQuery(request);
    const normalised = safeRelativePath(request.params['*']);
    if (!normalised) throw new EngineError('ASSET_REJECTED', `Unsafe asset path`);
    return engine.assetResolver.register(tenant, {
      path: normalised,
      bytes: request.body,
      mimeType: request.headers['content-type'] || 'application/octet-stream'
    });
  });

  app.get('/v1/assets', async (request) => {
    const tenant = requireTenantQuery(request);
    return engine.assetResolver.list(tenant);
  });
  app.get('/assets', async (request) => {
    const tenant = requireTenantQuery(request);
    return engine.assetResolver.list(tenant);
  });

  app.delete('/v1/assets/*', async (request, reply) => {
    const tenant = requireTenantQuery(request);
    await engine.assetResolver.remove(tenant, request.params['*']);
    reply.code(204).send();
    return reply;
  });
  app.delete('/assets/*', async (request, reply) => {
    const tenant = requireTenantQuery(request);
    await engine.assetResolver.remove(tenant, request.params['*']);
    reply.code(204).send();
    return reply;
  });

  // -------------------------------------------------------------- embeddable

  app.decorate('engine', engine);
  app.decorate('jobs', jobs);

  return app;
}

function applyProvenance(reply, artifact) {
  const provenance = artifact.provenance || {};
  if (provenance.templateVersion !== null && provenance.templateVersion !== undefined) {
    reply.header('x-template-version', String(provenance.templateVersion));
  }
  if (provenance.templateId) reply.header('x-template-id', provenance.templateId);
  if (provenance.schemaVersion !== null && provenance.schemaVersion !== undefined) {
    reply.header('x-schema-version', String(provenance.schemaVersion));
  }
  if (provenance.rendererImage) reply.header('x-renderer-image', String(provenance.rendererImage));
  if (provenance.inputHash) reply.header('x-input-hash', provenance.inputHash);
  if (artifact.pageCount !== null && artifact.pageCount !== undefined) {
    reply.header('x-page-count', String(artifact.pageCount));
  }
  if (artifact.handle) reply.header('x-artifact-handle', artifact.handle);
}

function requireTenantQuery(request) {
  const tenant = request.query && request.query.tenant;
  if (typeof tenant !== 'string' || tenant.length === 0) {
    throw new EngineError('REQUEST_INVALID', '`tenant` query parameter is required');
  }
  return tenant;
}

const MAX_JOBS = 500;

function pruneJobs(jobs) {
  if (jobs.size <= MAX_JOBS) return;
  const finished = [...jobs.values()]
    .filter((job) => job.status !== 'running')
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const job of finished.slice(0, jobs.size - MAX_JOBS)) jobs.delete(job.id);
}

function landingPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>PDfEr — templated document engine</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.55 ui-sans-serif, system-ui, sans-serif; max-width: 46rem; margin: 4rem auto; padding: 0 1.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
  pre { background: #111827; color: #e5e7eb; padding: 1rem; border-radius: .5rem; overflow-x: auto; }
  h1 { font-size: 1.6rem; letter-spacing: -.02em; }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid #d1d5db; }
  .muted { color: #6b7280; }
</style>
</head>
<body>
  <h1>PDfEr engine</h1>
  <p class="muted">Template + JSON in, PDF out. One container, no configuration.</p>

  <h2>Try it</h2>
  <pre>curl -s http://localhost:8080/document-types?tenant=demo

curl -s -X POST http://localhost:8080/render \\
  -H 'content-type: application/json' \\
  -d '{
    "tenant": "demo",
    "documentType": "invoice",
    "mode": "production",
    "template": "default",
    "generatedAt": "2026-01-31T09:00:00Z",
    "options": { "footerTemplateRef": "default" },
    "data": {
      "invoiceNumber": "INV-0000",
      "issuedOn": "2026-01-31",
      "customerName": "EXAMPLE CUSTOMER",
      "items": [
        { "description": "EXAMPLE ITEM", "quantity": 2, "unitPrice": 500, "lineTotal": 1000 }
      ],
      "total": 1000
    }
  }' --output invoice.pdf</pre>

  <h2>Surface</h2>
  <table>
    <tr><th>GET</th><td><code>/document-types?tenant=</code></td></tr>
    <tr><th>GET</th><td><code>/document-types/{type}/placeholders</code></td></tr>
    <tr><th>GET</th><td><code>/document-types/{type}/sample-data</code></td></tr>
    <tr><th>POST</th><td><code>/validate</code> · <code>/compile</code> · <code>/preview</code> · <code>/render</code></td></tr>
    <tr><th>GET</th><td><code>/templates</code> · <code>/artifacts/{handle}</code></td></tr>
    <tr><th>GET</th><td><code>/healthz</code> · <code>/readyz</code> · <code>/version</code> · <code>/metrics</code></td></tr>
  </table>
  <p class="muted">All routes are also available under <code>/v1</code>. Contract: <code>schema/openapi.yaml</code>.</p>
</body>
</html>`;
}

module.exports = { buildApp, METRICS, metricsText, FixedWindowLimiter, timingSafeEquals };
