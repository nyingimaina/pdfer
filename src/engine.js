'use strict';

const { EngineError } = require('./errors');
const { Binder, buildSampleData } = require('./binder');
const { analyze, compileText } = require('./liquid');
const { buildReport, publicReport } = require('./validate');
const { formatTemporal } = require('./format');
const {
  assertTenant,
  DOCUMENT_TYPE_RE,
  canonicalJson,
  sha256,
  escapeHtml,
  normalizeText,
  sanitizeFileName,
  parseIsoInstant,
  isPlainObject
} = require('./util');

const RESERVED_DESCRIPTORS = [
  {
    path: 'generatedAt',
    token: 'generatedAt',
    displayLabel: 'Generated at',
    group: 'Reserved',
    dataType: 'datetime',
    isCollection: false,
    isRequired: false,
    formatHint: 'yyyy-MM-dd HH:mm',
    sampleValue: '2026-01-31 09:00',
    loopVariable: null,
    children: [],
    reserved: true
  },
  {
    path: 'documentType',
    token: 'documentType',
    displayLabel: 'Document type',
    group: 'Reserved',
    dataType: 'string',
    isCollection: false,
    isRequired: false,
    formatHint: null,
    sampleValue: 'invoice',
    loopVariable: null,
    children: [],
    reserved: true
  },
  {
    path: 'title',
    token: 'title',
    displayLabel: 'Document title',
    group: 'Reserved',
    dataType: 'string',
    isCollection: false,
    isRequired: false,
    formatHint: null,
    sampleValue: 'Invoice',
    loopVariable: null,
    children: [],
    reserved: true
  }
];

const RENDER_FIELDS = new Set([
  'tenant', 'documentType', 'mode', 'template', 'inlineTemplate', 'data',
  'generatedAt', 'options', 'assets', 'output', 'format', 'schemaVersion',
  'useSampleData'
]);

const OPTION_FIELDS = new Set([
  'preferCssPageSize', 'paperWidth', 'paperHeight', 'marginTop', 'marginBottom',
  'marginLeft', 'marginRight', 'landscape', 'printBackground', 'scale',
  'nativePageRanges', 'waitForExpression', 'waitDelay', 'failOnHttpStatusCodes',
  'headerTemplateRef', 'footerTemplateRef', 'metadata', 'headerMargin', 'footerMargin'
]);

const METADATA_FIELDS = new Set(['title', 'author', 'subject', 'keywords']);

const MUTATING_TEMPLATE_METHODS = new Set([
  'saveNextVersion', 'publish', 'setDefault', 'retire'
]);
const MUTATING_OUTPUT_METHODS = new Set(['save']);

function purityGuard(target, mutating) {
  return new Proxy(target, {
    get(object, property, receiver) {
      if (mutating.has(property)) {
        return () => {
          throw new EngineError(
            'PREVIEW_SIDE_EFFECT_DENIED',
            `'${String(property)}' cannot be called while previewing (SPEC I-1)`
          );
        };
      }
      const value = Reflect.get(object, property, receiver);
      return typeof value === 'function' ? value.bind(object) : value;
    }
  });
}

function strictFields(object, allowed, label) {
  if (!isPlainObject(object)) {
    throw new EngineError('REQUEST_INVALID', `\`${label}\` must be an object`);
  }
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new EngineError('REQUEST_INVALID', `Unknown field '${key}' in \`${label}\``, {
        details: { field: key }
      });
    }
  }
}

function requireString(value, label, { max = 200 } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new EngineError('REQUEST_INVALID', `\`${label}\` must be a non-empty string (≤ ${max})`);
  }
  return value;
}

function requireDocumentType(value) {
  if (typeof value !== 'string' || !DOCUMENT_TYPE_RE.test(value)) {
    throw new EngineError('REQUEST_INVALID', `\`documentType\` must match ${DOCUMENT_TYPE_RE}`);
  }
  return value;
}

function requireTenant(value) {
  if (!assertTenant(value)) {
    throw new EngineError('REQUEST_INVALID', '`tenant` must match ^[a-z0-9][a-z0-9_-]{0,63}$ and not be numeric-only');
  }
  return value;
}

function serializeNode(node) {
  return {
    path: node.path,
    token: node.token,
    displayLabel: node.displayLabel,
    group: node.group,
    dataType: node.dataType,
    isCollection: node.isCollection,
    isRequired: node.isRequired,
    formatHint: node.formatHint,
    sampleValue: node.sampleValue,
    ...(node.loopVariable ? { loopVariable: node.loopVariable } : {}),
    children: node.children.map(serializeNode)
  };
}

function normalizeFormatHint(value) {
  if (value === undefined || value === null) return undefined;
  return String(value);
}

class DocumentEngine {
  constructor({
    config,
    registry,
    templateStore,
    outputStore,
    assetResolver,
    renderer,
    clock,
    logger
  }) {
    this.config = config;
    this.registry = registry;
    this.templateStore = templateStore;
    this.outputStore = outputStore;
    this.assetResolver = assetResolver;
    this.renderer = renderer;
    this.clock = clock;
    this.logger = logger;
    this.binder = new Binder({ maxRows: config.maxRows });
  }

  async init() {
    await Promise.all([
      this.templateStore.init(),
      this.outputStore.init(),
      this.assetResolver.init()
    ]);
    this.registry.assertNotEmpty();
  }

  // ---------------------------------------------------------------- catalogue

  async listDocumentTypes(tenant) {
    requireTenant(tenant);
    this.registry.assertNotEmpty();
    const counts = await this.templateStore.countsByType(tenant);
    const descriptors = [];
    for (const { documentType, schemaVersion } of this.registry.listDocumentTypes()) {
      const defaults = await this.templateStore.getDefault(tenant, documentType);
      descriptors.push({
        documentType,
        displayLabel: documentType.replace(/(^|-)([a-z])/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase()),
        placeholderSchemaVersion: schemaVersion,
        supportedSyntaxes: ['liquid'],
        supportsPreview: true,
        templateCount: counts.get(documentType) || 0,
        defaultTemplateId: defaults ? defaults.templateId : null
      });
    }
    return descriptors;
  }

  getPlaceholderSchema(documentType, version) {
    requireDocumentType(documentType);
    const schema = this.registry.resolve(documentType, version);
    return {
      documentType,
      schemaVersion: schema.schemaVersion,
      root: [...schema.root.map(serializeNode), ...RESERVED_DESCRIPTORS.map((d) => ({ ...d }))]
    };
  }

  getSampleData(documentType, version) {
    requireDocumentType(documentType);
    const schema = this.registry.resolve(documentType, version);
    return buildSampleData(schema);
  }

  async getTemplate(ref, tenant) {
    requireTenant(tenant);
    if (!ref || typeof ref.templateId !== 'string') {
      throw new EngineError('REQUEST_INVALID', '`templateId` is required');
    }
    const version = Number(ref.version);
    if (!Number.isInteger(version) || version < 1) {
      throw new EngineError('REQUEST_INVALID', '`version` must be a positive integer');
    }
    return this.templateStore.get({ templateId: ref.templateId, version }, tenant);
  }

  async listTemplates(tenant, { documentType, state, limit, cursor }) {
    requireTenant(tenant);
    if (!documentType) throw new EngineError('REQUEST_INVALID', '`documentType` is required');
    requireDocumentType(documentType);
    if (state && !['draft', 'published', 'retired'].includes(state)) {
      throw new EngineError('REQUEST_INVALID', "`state` must be draft, published or retired");
    }
    const pageSize = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.templateStore.list(tenant, documentType, { state, limit: pageSize, cursor });
  }

  // ------------------------------------------------------------------ writes

  async saveTemplate(body) {
    strictFields(body, new Set([
      'tenant', 'documentType', 'sourceTemplateId', 'syntaxId', 'content',
      'displayLabel', 'baseVersion', 'createdBy'
    ]), 'template');
    const tenant = requireTenant(body.tenant);
    const documentType = requireDocumentType(body.documentType);
    if (body.syntaxId !== undefined && body.syntaxId !== 'liquid') {
      throw new EngineError('REQUEST_INVALID', "`syntaxId` must be 'liquid'");
    }
    const schemaVersion = this.registry.latestVersion(documentType);
    if (schemaVersion === null) {
      throw new EngineError('SCHEMA_VERSION_UNKNOWN', `Unknown document type '${documentType}'`);
    }
    return this.templateStore.saveNextVersion({
      tenant,
      documentType,
      content: body.content,
      displayLabel: body.displayLabel,
      syntaxId: 'liquid',
      schemaVersion,
      sourceTemplateId: body.sourceTemplateId || null,
      baseVersion: body.baseVersion === undefined ? null : Number(body.baseVersion),
      createdBy: body.createdBy || null
    });
  }

  async publishTemplate(ref, tenant) {
    return this.templateStore.publish(ref, requireTenant(tenant));
  }

  async setDefaultTemplate(ref, tenant) {
    return this.templateStore.setDefault(ref, requireTenant(tenant));
  }

  async retireTemplate(ref, tenant) {
    return this.templateStore.retire(ref, requireTenant(tenant));
  }

  // --------------------------------------------------------------- validation

  async validate(req) {
    const { content, schema, authoredSchemaVersion, hasHeaderOrFooter } = await this.#resolveForValidation(req);
    const report = await buildReport({
      content,
      schema,
      data: req.data ?? null,
      binder: this.binder,
      assetResolver: this.assetResolver,
      tenant: req.tenant,
      assets: req.assets || null,
      hasHeaderOrFooter,
      allowDataUris: this.config.allowDataUris,
      maxTemplateBytes: this.config.maxTemplateBytes,
      authoredSchemaVersion
    });
    return publicReport(report);
  }

  async #resolveForValidation(req) {
    strictFields(req, RENDER_FIELDS, 'request');
    const tenant = requireTenant(req.tenant);
    const documentType = requireDocumentType(req.documentType);
    const hasOptions = req.options !== undefined && req.options !== null;
    if (hasOptions) strictFields(req.options, OPTION_FIELDS, 'options');

    if (req.inlineTemplate && req.template) {
      throw new EngineError('REQUEST_INVALID', 'Provide exactly one of `template` or `inlineTemplate`');
    }
    if (req.inlineTemplate) {
      const inline = req.inlineTemplate;
      strictFields(inline, new Set(['syntaxId', 'content', 'displayLabel']), 'inlineTemplate');
      if (inline.syntaxId !== undefined && inline.syntaxId !== 'liquid') {
        throw new EngineError('REQUEST_INVALID', "`syntaxId` must be 'liquid'");
      }
      requireString(inline.content, 'inlineTemplate.content', { max: this.config.maxTemplateBytes });
      const schema = this.registry.resolve(documentType, req.schemaVersion);
      return {
        content: normalizeText(inline.content),
        schema,
        authoredSchemaVersion: req.schemaVersion ?? null,
        hasHeaderOrFooter: Boolean(
          req.options && (req.options.headerTemplateRef || req.options.footerTemplateRef)
        )
      };
    }

    if (!req.template) {
      throw new EngineError('REQUEST_INVALID', 'Provide `template` or `inlineTemplate`');
    }
    const record = await this.templateStore.resolve(tenant, documentType, req.template);
    const schema = this.registry.resolve(documentType, req.schemaVersion ?? record.schemaVersion);
    return {
      content: record.content,
      schema,
      authoredSchemaVersion: record.schemaVersion,
      hasHeaderOrFooter: Boolean(
        req.options && (req.options.headerTemplateRef || req.options.footerTemplateRef)
      )
    };
  }

  // ------------------------------------------------------------------ compile

  async compile(req) {
    const prepared = await this.#prepare(req, { mode: req.mode || 'preview', allowSample: false });
    return {
      html: prepared.html,
      schemaVersion: prepared.schema.schemaVersion,
      warnings: prepared.warnings,
      provenance: prepared.provenance
    };
  }

  async preview(req) {
    const prepared = await this.#prepare(req, { mode: 'preview', allowSample: true });
    if (req.format === 'html') {
      return {
        artifact: {
          documentType: prepared.documentType,
          fileName: null,
          contentType: 'text/html; charset=utf-8',
          byteLength: Buffer.byteLength(prepared.html, 'utf8'),
          pageCount: null,
          provenance: prepared.provenance,
          warnings: prepared.warnings
        },
        bytes: Buffer.from(prepared.html, 'utf8')
      };
    }
    const rendered = await this.renderer.render({
      html: prepared.html,
      assets: prepared.bundle,
      headerHtml: prepared.headerHtml,
      footerHtml: prepared.footerHtml,
      options: prepared.renderOptions
    });
    return {
      artifact: {
        documentType: prepared.documentType,
        fileName: sanitizeFileName(`${prepared.documentType}-preview.pdf`),
        contentType: 'application/pdf',
        byteLength: rendered.bytes.length,
        pageCount: rendered.pageCount,
        provenance: prepared.provenance,
        warnings: prepared.warnings
      },
      bytes: rendered.bytes
    };
  }

  // ------------------------------------------------------------------- render

  async render(req, { signal } = {}) {
    const mode = req.mode || 'production';
    if (mode !== 'production' && mode !== 'preview') {
      throw new EngineError('REQUEST_INVALID', "`mode` must be 'preview' or 'production'");
    }
    const prepared = await this.#prepare(req, { mode, allowSample: true });

    if (prepared.format === 'html') {
      const bytes = Buffer.from(prepared.html, 'utf8');
      return {
        artifact: {
          documentType: prepared.documentType,
          fileName: sanitizeFileName(`${prepared.documentType}.html`),
          contentType: 'text/html; charset=utf-8',
          byteLength: bytes.length,
          pageCount: null,
          provenance: prepared.provenance,
          warnings: prepared.warnings
        },
        bytes
      };
    }

    const rendered = await this.renderer.render({
      html: prepared.html,
      assets: prepared.bundle,
      headerHtml: prepared.headerHtml,
      footerHtml: prepared.footerHtml,
      options: prepared.renderOptions,
      signal
    });

    const fileName = sanitizeFileName(
      (req.output && req.output.fileName) || `${prepared.documentType}.pdf`
    );

    const provenance = { ...prepared.provenance, byteLength: rendered.bytes.length };

    let stored = null;
    if (mode === 'production') {
      stored = await this.outputStore.save(prepared.tenant, {
        fileName,
        bytes: rendered.bytes,
        contentType: 'application/pdf',
        provenance
      });
    }

    this.logger.info(
      {
        tenant: prepared.tenant,
        documentType: prepared.documentType,
        templateId: provenance.templateId,
        templateVersion: provenance.templateVersion,
        schemaVersion: provenance.schemaVersion,
        inputHash: provenance.inputHash,
        rendererImage: provenance.rendererImage,
        pageCount: rendered.pageCount,
        mode
      },
      'render complete'
    );

    return {
      artifact: {
        documentType: prepared.documentType,
        fileName,
        contentType: 'application/pdf',
        byteLength: rendered.bytes.length,
        pageCount: rendered.pageCount,
        handle: stored ? stored.handle : null,
        provenance,
        warnings: prepared.warnings
      },
      bytes: rendered.bytes
    };
  }

  async renderTo(destination, req, opts = {}) {
    const { artifact, bytes } = await this.render(req, opts);
    if (typeof destination.write === 'function') {
      destination.write(bytes);
    }
    return { artifact };
  }

  // ------------------------------------------------------------------ prepare

  async #prepare(req, { mode, allowSample }) {
    strictFields(req, RENDER_FIELDS, 'request');
    // Preview runs against guarded stores: any accidental mutation throws
    // PREVIEW_SIDE_EFFECT_DENIED rather than being silently tolerated (I-1).
    const store = mode === 'preview'
      ? purityGuard(this.templateStore, MUTATING_TEMPLATE_METHODS)
      : this.templateStore;
    if (req.mode && req.mode !== mode) {
      throw new EngineError('REQUEST_INVALID', `\`mode\` must be '${mode}' for this operation`);
    }
    const tenant = requireTenant(req.tenant);
    const documentType = requireDocumentType(req.documentType);

    if (req.options !== undefined && req.options !== null) {
      strictFields(req.options, OPTION_FIELDS, 'options');
      if (req.options.metadata !== undefined) {
        strictFields(req.options.metadata, METADATA_FIELDS, 'options.metadata');
      }
    }
    if (req.output !== undefined && req.output !== null) {
      strictFields(req.output, new Set(['fileName']), 'output');
    }

    const useSample = req.useSampleData === true;
    if (useSample && !allowSample) {
      throw new EngineError('REQUEST_INVALID', '`useSampleData` is only valid for preview and validate');
    }
    if (useSample && req.data !== undefined && req.data !== null) {
      throw new EngineError('REQUEST_INVALID', 'Provide either `data` or `useSampleData: true`, not both');
    }

    const hasInline = req.inlineTemplate !== undefined && req.inlineTemplate !== null;
    const hasTemplate = req.template !== undefined && req.template !== null;
    if (hasInline && hasTemplate) {
      throw new EngineError('REQUEST_INVALID', 'Provide exactly one of `template` or `inlineTemplate`');
    }
    if (mode === 'production') {
      if (hasInline) {
        throw new EngineError(
          'INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION',
          'Production renders must reference a persisted, published template version'
        );
      }
      if (!hasTemplate) throw new EngineError('REQUEST_INVALID', '`template` is required in production');
    } else if (!hasInline && !hasTemplate) {
      throw new EngineError('REQUEST_INVALID', 'Provide `template` or `inlineTemplate`');
    }

    if (req.format !== undefined && !['pdf', 'html'].includes(req.format)) {
      throw new EngineError('REQUEST_INVALID', "`format` must be 'pdf' or 'html'");
    }
    const format = req.format || 'pdf';

    const generatedAt = requireString(req.generatedAt, 'generatedAt', { max: 64 });
    if (!parseIsoInstant(generatedAt)) {
      throw new EngineError('REQUEST_INVALID', '`generatedAt` must be an RFC 3339 UTC timestamp ending in Z');
    }

    let inline = null;
    let record = null;
    let content;
    let schema;
    let templateId = null;
    let templateVersion = null;
    let syntaxId = 'liquid';

    if (hasInline) {
      if (mode === 'production') {
        throw new EngineError(
          'INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION',
          'Production renders must reference a persisted, published template version'
        );
      }
      inline = req.inlineTemplate;
      strictFields(inline, new Set(['syntaxId', 'content', 'displayLabel']), 'inlineTemplate');
      if (inline.syntaxId !== undefined && inline.syntaxId !== 'liquid') {
        throw new EngineError('REQUEST_INVALID', "`syntaxId` must be 'liquid'");
      }
      requireString(inline.content, 'inlineTemplate.content', { max: this.config.maxTemplateBytes });
      const byteLength = Buffer.byteLength(inline.content, 'utf8');
      if (byteLength > this.config.maxTemplateBytes) {
        throw new EngineError('TEMPLATE_TOO_LARGE', `Template exceeds ${this.config.maxTemplateBytes} bytes`);
      }
      content = normalizeText(inline.content);
      schema = this.registry.resolve(documentType, req.schemaVersion);
    } else {
      record = await store.resolve(tenant, documentType, req.template);
      if (record.tenant !== tenant) {
        throw new EngineError('TENANT_MISMATCH', 'Resolved template belongs to another tenant');
      }
      if (mode === 'production' && record.state !== 'published') {
        throw new EngineError(
          'TEMPLATE_NOT_PUBLISHED',
          `Template ${record.templateId} v${record.version} is '${record.state}'`
        );
      }
      content = record.content;
      schema = this.registry.resolve(documentType, req.schemaVersion ?? record.schemaVersion);
      templateId = record.templateId;
      templateVersion = record.version;
      syntaxId = record.syntaxId || 'liquid';
    }

    const rawData = useSample ? buildSampleData(schema) : req.data;
    if (!useSample && (rawData === undefined || rawData === null)) {
      throw new EngineError('REQUEST_INVALID', '`data` is required (or set `useSampleData: true`)');
    }
    const dataBytes = Buffer.byteLength(JSON.stringify(rawData), 'utf8');
    if (dataBytes > this.config.maxDataBytes) {
      throw new EngineError('DATA_TOO_LARGE', `\`data\` exceeds ${this.config.maxDataBytes} bytes`, {
        details: { byteLength: dataBytes, maximum: this.config.maxDataBytes }
      });
    }

    const model = this.binder.bind(rawData, schema);
    model.generatedAt = formatTemporal(generatedAt, 'yyyy-MM-dd HH:mm');
    model.documentType = documentType;
    model.title = escapeHtml(
      (req.options && req.options.metadata && req.options.metadata.title) || documentType
    );

    const html = compileText(content, model);

    // Header/footer are compiled by the same engine, with the same model.
    const header = await this.#compileDecorator(req, tenant, documentType, 'header', model, mode, store);
    const footer = await this.#compileDecorator(req, tenant, documentType, 'footer', model, mode, store);
    const headerHtml = header ? header.html : null;
    const footerHtml = footer ? footer.html : null;
    const footerSource = footer ? footer.source : '';

    const mainAnalysis = analyze(content, schema, {
      allowDataUris: this.config.allowDataUris,
      hasHeaderOrFooter: Boolean(headerHtml || footerHtml)
    });
    if (mainAnalysis.syntaxErrors.length || mainAnalysis.unknownTokens.length) {
      const first = mainAnalysis.syntaxErrors[0] || mainAnalysis.unknownTokens[0];
      throw new EngineError(first.code || 'UNKNOWN_TOKEN', first.message || 'Template is invalid', {
        location: first.location,
        details: { diagnostic: first }
      });
    }

    const referenced = new Set(mainAnalysis.assetRefs);
    if (footerSource) {
      for (const ref of analyze(footerSource, schema, {}).assetRefs) referenced.add(ref);
    }
    if (headerHtml) {
      for (const ref of analyze(header.html, schema, {}).assetRefs) referenced.add(ref);
    }

    const declared = Array.isArray(req.assets)
      ? req.assets.map((entry) =>
          entry && typeof entry === 'object'
            ? { path: entry.path, assetRef: entry.assetRef, mimeType: entry.mimeType }
            : { path: String(entry) }
        )
      : null;

    const bundle = declared
      ? await this.assetResolver.bundle(tenant, declared)
      : await this.assetResolver.bundle(
          tenant,
          [...referenced].map((path) => ({ path }))
        );

    if (declared) {
      const provided = new Set(bundle.map((item) => item.path));
      for (const ref of referenced) {
        if (!provided.has(ref)) {
          throw new EngineError('ASSET_MISSING', `Asset '${ref}' is referenced but not in the request bundle`, {
            details: { path: ref }
          });
        }
      }
    }

    const renderOptions = this.#renderOptions(req, { hasHeader: Boolean(headerHtml), hasFooter: Boolean(footerHtml) });

    const inputHash = 'sha256:' + sha256(
      canonicalJson({
        html,
        header: headerHtml || '',
        footer: footerHtml || '',
        assets: bundle.map((asset) => ({ path: asset.path, sha256: asset.sha256 })),
        options: renderOptions
      })
    );
    const dataHash = 'sha256:' + sha256(canonicalJson(model));

    const health = await this.renderer.health();
    const provenance = {
      templateId,
      templateVersion,
      schemaVersion: schema.schemaVersion,
      syntaxId,
      rendererImage: health.ok ? health.version : null,
      inputHash,
      dataHash
    };

    return {
      tenant,
      documentType,
      templateId,
      schema,
      model,
      html,
      headerHtml,
      footerHtml,
      bundle,
      renderOptions,
      warnings: mainAnalysis.warnings,
      provenance,
      format,
      mode
    };
  }

  // ------------------------------------------------------------------ prepare

  async #compileDecorator(req, tenant, documentType, kind, model, mode, store) {
    const options = req.options || {};
    const key = kind === 'header' ? 'headerTemplateRef' : 'footerTemplateRef';
    const ref = options[key];
    if (!ref) return null;

    let record;
    if (ref === 'default') {
      // SPEC §3.12 / Appendix E-1: decorators live in synthetic document types.
      const synthetic = `${documentType}-${kind}`;
      const targetType = this.registry.has(synthetic) ? synthetic : documentType;
      record = await store.resolve(tenant, targetType, 'default');
    } else {
      if (typeof ref !== 'object' || typeof ref.templateId !== 'string') {
        throw new EngineError(
          'REQUEST_INVALID',
          `\`options.${key}\` must be "default" or { templateId, version }`
        );
      }
      const version = Number(ref.version);
      if (!Number.isInteger(version) || version < 1) {
        throw new EngineError('REQUEST_INVALID', `\`options.${key}.version\` must be a positive integer`);
      }
      record = await store.get({ templateId: ref.templateId, version }, tenant);
    }

    if (mode === 'production' && record.state !== 'published') {
      throw new EngineError('TEMPLATE_NOT_PUBLISHED', `${kind} template is '${record.state}'`);
    }
    return { html: compileText(record.content, model), source: record.content };
  }

  #renderOptions(req, { hasHeader, hasFooter }) {
    const raw = req.options || {};
    const scale = raw.scale === undefined ? 1 : Number(raw.scale);
    if (!Number.isFinite(scale) || scale < 0.1 || scale > 2) {
      throw new EngineError('REQUEST_INVALID', '`options.scale` must be between 0.1 and 2.0');
    }
    if (raw.preferCssPageSize !== undefined && typeof raw.preferCssPageSize !== 'boolean') {
      throw new EngineError('REQUEST_INVALID', '`options.preferCssPageSize` must be a boolean');
    }
    if (raw.printBackground !== undefined && typeof raw.printBackground !== 'boolean') {
      throw new EngineError('REQUEST_INVALID', '`options.printBackground` must be a boolean');
    }
    if (raw.landscape !== undefined && typeof raw.landscape !== 'boolean') {
      throw new EngineError('REQUEST_INVALID', '`options.landscape` must be a boolean');
    }

    const preferCssPageSize = raw.preferCssPageSize !== false;
    const headerMargin = raw.headerMargin === undefined ? 12 : Number(raw.headerMargin);
    const footerMargin = raw.footerMargin === undefined ? 12 : Number(raw.footerMargin);

    const options = {
      preferCssPageSize,
      printBackground: raw.printBackground !== false,
      landscape: raw.landscape === true,
      scale,
      metadata: raw.metadata || {},
      nativePageRanges: raw.nativePageRanges || null,
      waitDelay: raw.waitDelay || null,
      waitForExpression: raw.waitForExpression || null,
      failOnHttpStatusCodes: raw.failOnHttpStatusCodes || undefined
    };

    if (raw.paperWidth !== undefined) options.paperWidth = raw.paperWidth;
    if (raw.paperHeight !== undefined) options.paperHeight = raw.paperHeight;
    if (raw.marginTop !== undefined) options.marginTop = Number(raw.marginTop);
    if (raw.marginBottom !== undefined) options.marginBottom = Number(raw.marginBottom);
    if (raw.marginLeft !== undefined) options.marginLeft = Number(raw.marginLeft);
    if (raw.marginRight !== undefined) options.marginRight = Number(raw.marginRight);

    if (!preferCssPageSize) {
      options.paperWidth = options.paperWidth || '210mm';
      options.paperHeight = options.paperHeight || '297mm';
      options.marginTop = options.marginTop ?? 0;
      options.marginBottom = options.marginBottom ?? 0;
      options.marginLeft = options.marginLeft ?? 0;
      options.marginRight = options.marginRight ?? 0;
      if (hasHeader && raw.marginTop === undefined) options.marginTop = headerMargin;
      if (hasFooter && raw.marginBottom === undefined) options.marginBottom = footerMargin;
    }

    return options;
  }
}

module.exports = { DocumentEngine, RESERVED_DESCRIPTORS, serializeNode };
