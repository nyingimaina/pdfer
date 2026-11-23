'use strict';

/**
 * Embeddable surface (SPEC D-3). Hosts that want to avoid the HTTP hop can
 * build a runtime and call the engine directly; behaviour is identical.
 */
const { createRuntime, main } = require('./server');
const { DocumentEngine } = require('./engine');
const { SchemaRegistry } = require('./schema');
const { TemplateStore } = require('./ports/templateStore');
const { OutputStore } = require('./ports/outputStore');
const { AssetResolver } = require('./ports/assetResolver');
const { GotenbergRenderer } = require('./ports/renderer');
const { loadConfig } = require('./config');
const { createLogger } = require('./logger');

module.exports = {
  createRuntime,
  main,
  DocumentEngine,
  SchemaRegistry,
  TemplateStore,
  OutputStore,
  AssetResolver,
  GotenbergRenderer,
  loadConfig,
  createLogger
};
