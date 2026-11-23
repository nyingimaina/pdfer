'use strict';

const path = require('node:path');

const { loadConfig } = require('./config');
const { createLogger } = require('./logger');
const { SchemaRegistry } = require('./schema');
const { SCHEMAS, loadSchemasFromFile } = require('./schemas');
const { TemplateStore } = require('./ports/templateStore');
const { OutputStore } = require('./ports/outputStore');
const { AssetResolver } = require('./ports/assetResolver');
const { GotenbergRenderer } = require('./ports/renderer');
const { RendererProcess } = require('./rendererProcess');
const { DocumentEngine } = require('./engine');
const { buildApp, METRICS } = require('./http/app');
const { seedDemo } = require('./seed');

async function createRuntime(overrides = {}) {
  const config = overrides.config || loadConfig();
  const logger = overrides.logger || createLogger(config.logLevel);
  const clock = overrides.clock || { now: () => new Date().toISOString() };

  const registry = overrides.registry || new SchemaRegistry();
  if (!overrides.registry) {
    for (const schema of SCHEMAS) registry.register(schema);
    if (config.schemasFile) {
      const extra = await loadSchemasFromFile(config.schemasFile);
      for (const schema of extra) registry.register(schema);
      logger.info({ file: config.schemasFile, count: extra.length }, 'schema manifest loaded');
    }
  }

  const templateStore = overrides.templateStore || new TemplateStore({
    root: config.dataDir,
    clock,
    logger
  });
  const outputStore = overrides.outputStore || new OutputStore({ root: config.dataDir, clock });
  const assetResolver = overrides.assetResolver || new AssetResolver({
    root: config.dataDir,
    maxAssetBytes: config.maxAssetBytes,
    maxBundleBytes: config.maxBundleBytes
  });

  const renderer = overrides.renderer || new GotenbergRenderer({
    baseUrl: config.renderer.baseUrl,
    timeoutMs: config.renderTimeoutMs,
    retries: config.renderRetries,
    maxConcurrency: config.maxConcurrency,
    maxQueue: config.maxQueue,
    maxOutputBytes: config.maxOutputBytes,
    javascriptEnabled: config.renderer.javascriptEnabled,
    logger
  });

  const engine = new DocumentEngine({
    config,
    registry,
    templateStore,
    outputStore,
    assetResolver,
    renderer,
    clock,
    logger
  });

  return { config, logger, clock, registry, templateStore, outputStore, assetResolver, renderer, engine };
}

async function main() {
  const runtime = await createRuntime();
  const { config, logger, engine, registry, templateStore, assetResolver } = runtime;

  await engine.init();

  if (config.artifactRetentionDays > 0) {
    const sweep = async () => {
      try {
        const result = await runtime.outputStore.sweep({
          maxAgeDays: config.artifactRetentionDays,
          logger
        });
        METRICS.artifactsRemoved += result.removed;
      } catch (error) {
        logger.error({ err: error.message }, 'artifact retention sweep failed');
      }
    };
    await sweep();
    const retentionTimer = setInterval(sweep, 6 * 60 * 60 * 1000);
    retentionTimer.unref();
    logger.info(
      { retentionDays: config.artifactRetentionDays },
      'artifact retention enabled'
    );
  }

  let rendererProcess = null;
  if (!config.renderer.external) {
    rendererProcess = new RendererProcess({ config, logger, renderer: runtime.renderer });
    runtime.renderer.setHooks({
      ensureStarted: () => rendererProcess.ensureStarted(),
      onActivity: () => rendererProcess.noteActivity()
    });
    await rendererProcess.start();
  } else {
    logger.info({ renderer: config.renderer.baseUrl }, 'using external renderer');
  }

  let seedResult = { seeded: false };
  if (config.seedDemo) {
    seedResult = await seedDemo({
      config,
      engine,
      templateStore,
      assetResolver,
      logger,
      seedDir: path.join(__dirname, '..', 'seed')
    });
  }

  const app = buildApp({ engine, config, rendererProcess, logger, registry });

  if (seedResult.seeded) {
    const started = Date.now();
    try {
      const sample = engine.getSampleData('invoice');
      const { artifact } = await engine.preview({
        tenant: seedResult.tenant,
        documentType: 'invoice',
        mode: 'preview',
        template: 'default',
        data: sample,
        generatedAt: new Date().toISOString(),
        options: { footerTemplateRef: 'default' },
        format: 'pdf'
      });
      logger.info(
        { pageCount: artifact.pageCount, ms: Date.now() - started },
        'startup self-test passed'
      );
    } catch (error) {
      logger.error({ err: error.message, code: error.code }, 'startup self-test failed');
      if (rendererProcess) await rendererProcess.stop();
      process.exit(1);
    }
  }

  await app.listen({ port: config.port, host: config.host });

  if (config.authMode === 'off') {
    logger.warn(
      { host: config.host, port: config.port },
      'authentication is DISABLED — do not expose this port outside a trusted network'
    );
  }

  logger.info(
    {
      port: config.port,
      dataDir: config.dataDir,
      embeddedRenderer: !config.renderer.external,
      authMode: config.authMode,
      seeded: seedResult.seeded
    },
    'PDfEr engine listening'
  );

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 20000);
    timer.unref();
    try {
      await app.close();
      if (rendererProcess) await rendererProcess.stop();
    } catch (error) {
      logger.error({ err: error.message }, 'shutdown error');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: String(reason) }, 'unhandled rejection');
  });

  return { app, runtime, rendererProcess };
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        time: new Date().toISOString(),
        msg: 'fatal startup error',
        err: error.message,
        stack: process.env.PDFER_LOG_LEVEL === 'debug' ? error.stack : undefined
      }) + '\n'
    );
    process.exit(1);
  });
}

module.exports = { main, createRuntime };
