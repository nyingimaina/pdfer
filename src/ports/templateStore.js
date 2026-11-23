'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EngineError } = require('../errors');
const { KeyedMutex, normalizeText, sha256, randomId, truncate } = require('../util');

/**
 * Filesystem TemplateStore (SPEC §6.1, §3.5, §3.6, §3.7).
 *
 * Layout:
 *   templates/<tenant>/<documentType>/<templateId>/meta.json
 *   templates/<tenant>/<documentType>/<templateId>/v<version>.json
 *   state/<tenant>/<documentType>.json      { defaultTemplateId, defaultVersion }
 *   index/<templateId>.json                 { tenant, documentType }
 *
 * Single-writer by design: the engine serialises writes in-process and uses
 * atomic rename. Documented in the README; scale-out uses the Postgres adapter.
 */
class TemplateStore {
  constructor({ root, clock, logger }) {
    this.root = root;
    this.clock = clock;
    this.logger = logger;
    this.mutex = new KeyedMutex();
  }

  get templatesRoot() {
    return path.join(this.root, 'templates');
  }

  get stateRoot() {
    return path.join(this.root, 'state');
  }

  get indexRoot() {
    return path.join(this.root, 'index');
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.templatesRoot, { recursive: true }),
      fs.mkdir(this.stateRoot, { recursive: true }),
      fs.mkdir(this.indexRoot, { recursive: true })
    ]);
  }

  #dir(tenant, documentType, templateId) {
    return path.join(this.templatesRoot, tenant, documentType, templateId);
  }

  #statePath(tenant, documentType) {
    return path.join(this.stateRoot, tenant, `${documentType}.json`);
  }

  #indexPath(templateId) {
    return path.join(this.indexRoot, `${templateId}.json`);
  }

  async #writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  async #readJson(file) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async #readIndex(templateId) {
    return this.#readJson(this.#indexPath(templateId));
  }

  async #readMeta(tenant, documentType, templateId) {
    return this.#readJson(path.join(this.#dir(tenant, documentType, templateId), 'meta.json'));
  }

  async #readVersion(tenant, documentType, templateId, version) {
    return this.#readJson(
      path.join(this.#dir(tenant, documentType, templateId), `v${version}.json`)
    );
  }

  async #writeVersion(tenant, documentType, templateId, record) {
    await this.#writeJson(
      path.join(this.#dir(tenant, documentType, templateId), `v${record.version}.json`),
      record
    );
  }

  async #readState(tenant, documentType) {
    return this.#readJson(this.#statePath(tenant, documentType));
  }

  async #writeState(tenant, documentType, state) {
    await this.#writeJson(this.#statePath(tenant, documentType), state);
  }

  /** Metadata-only view of a stored version. */
  #publicRecord(record, state) {
    const { content, ...rest } = record;
    return { ...rest, state, isDefault: false };
  }

  async #loadById(templateId, tenant) {
    const index = await this.#readIndex(templateId);
    if (!index || index.tenant !== tenant) {
      throw new EngineError('TEMPLATE_NOT_FOUND', `Template '${templateId}' was not found`);
    }
    return index;
  }

  async get(templateRef, tenant) {
    const { templateId, version } = templateRef;
    const index = await this.#loadById(templateId, tenant);
    const record = await this.#readVersion(index.tenant, index.documentType, templateId, version);
    if (!record) {
      throw new EngineError('TEMPLATE_NOT_FOUND', `Template '${templateId}' v${version} was not found`);
    }
    const state = await this.#readState(index.tenant, index.documentType);
    const isDefault = Boolean(
      state && state.defaultTemplateId === templateId && state.defaultVersion === version
    );
    return { ...record, isDefault, tenant: index.tenant, documentType: index.documentType };
  }

  async list(tenant, documentType, { state, limit = 100, cursor = null } = {}) {
    const base = path.join(this.templatesRoot, tenant, documentType);
    let ids = [];
    try {
      ids = (await fs.readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    const stateFile = await this.#readState(tenant, documentType);
    const rows = [];
    for (const templateId of ids) {
      const meta = await this.#readMeta(tenant, documentType, templateId);
      if (!meta) continue;
      for (let version = 1; version <= meta.latestVersion; version++) {
        const record = await this.#readVersion(tenant, documentType, templateId, version);
        if (!record) continue;
        const lifecycle = record.state;
        if (state && lifecycle !== state) continue;
        const isDefault = Boolean(
          stateFile &&
            stateFile.defaultTemplateId === templateId &&
            stateFile.defaultVersion === version
        );
        rows.push({ ...this.#publicRecord(record, lifecycle), isDefault });
      }
    }

    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      if (a.templateId !== b.templateId) return a.templateId < b.templateId ? -1 : 1;
      return b.version - a.version;
    });

    const offset = cursor ? Number(Buffer.from(cursor, 'base64').toString('utf8')) || 0 : 0;
    const page = rows.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    return {
      items: page,
      nextCursor: nextOffset < rows.length
        ? Buffer.from(String(nextOffset), 'utf8').toString('base64')
        : null
    };
  }

  async resolve(tenant, documentType, ref) {
    if (typeof ref === 'string') {
      if (ref !== 'default') {
        throw new EngineError('REQUEST_INVALID', "`template` must be \"default\" or a TemplateRef");
      }
      const state = await this.#readState(tenant, documentType);
      if (!state || !state.defaultTemplateId) {
        throw new EngineError(
          'NO_DEFAULT_TEMPLATE',
          `No default template is published for '${documentType}' in tenant '${tenant}'`,
          { details: { tenant, documentType } }
        );
      }
      const record = await this.get(
        { templateId: state.defaultTemplateId, version: state.defaultVersion },
        tenant
      );
      if (record.state !== 'published') {
        throw new EngineError('TEMPLATE_NOT_PUBLISHED', `Default template for '${documentType}' is '${record.state}'`);
      }
      return { ...record, isDefault: true };
    }

    if (ref && typeof ref === 'object' && typeof ref.templateId === 'string') {
      const version = Number(ref.version);
      if (!Number.isInteger(version) || version < 1) {
        throw new EngineError('REQUEST_INVALID', '`template.version` must be a positive integer');
      }
      const record = await this.get({ templateId: ref.templateId, version }, tenant);
      if (record.documentType !== documentType) {
        throw new EngineError(
          'TENANT_MISMATCH',
          `Template '${ref.templateId}' belongs to document type '${record.documentType}'`,
          { details: { expected: documentType, actual: record.documentType } }
        );
      }
      return record;
    }

    throw new EngineError('REQUEST_INVALID', '`template` must be "default" or { templateId, version }');
  }

  async saveNextVersion({
    tenant,
    documentType,
    content,
    displayLabel,
    syntaxId = 'liquid',
    schemaVersion,
    sourceTemplateId = null,
    baseVersion = null,
    expectedChecksum = null,
    createdBy = null
  }) {
    const normalized = normalizeText(content);
    if (typeof normalized !== 'string' || normalized.length === 0) {
      throw new EngineError('REQUEST_INVALID', '`content` must be a non-empty string');
    }
    const checksum = 'sha256:' + sha256(normalized);
    const lockKey = `${tenant}|${documentType}|${sourceTemplateId || 'new'}`;

    return this.mutex.run(lockKey, async () => {
      let templateId = sourceTemplateId;
      let meta = null;
      let currentMax = 0;

      if (templateId) {
        const index = await this.#loadById(templateId, tenant);
        if (index.documentType !== documentType) {
          throw new EngineError('TENANT_MISMATCH', `Template '${templateId}' is not for '${documentType}'`);
        }
        meta = await this.#readMeta(tenant, documentType, templateId);
        if (!meta) throw new EngineError('TEMPLATE_NOT_FOUND', `Template '${templateId}' was not found`);
        currentMax = meta.latestVersion;
      }

      if (baseVersion !== null && baseVersion !== undefined && Number(baseVersion) !== currentMax) {
        throw new EngineError(
          'VERSION_CONFLICT',
          `Template has moved on: expected base version ${baseVersion}, current version is ${currentMax}`,
          { details: { baseVersion: Number(baseVersion), currentVersion: currentMax } }
        );
      }

      if (expectedChecksum && currentMax > 0) {
        const current = await this.#readVersion(tenant, documentType, templateId, currentMax);
        if (!current || current.checksum !== expectedChecksum) {
          throw new EngineError('VERSION_CONFLICT', 'Template content changed since it was read', {
            details: { expected: expectedChecksum, actual: current ? current.checksum : null }
          });
        }
      }

      if (!templateId) templateId = randomId('tpl_');
      const version = currentMax + 1;
      const createdAt = this.clock.now();

      const record = {
        templateId,
        tenant,
        documentType,
        version,
        displayLabel: displayLabel || `${documentType} v${version}`,
        syntaxId,
        state: 'draft',
        schemaVersion,
        checksum,
        contentLengthBytes: Buffer.byteLength(normalized, 'utf8'),
        createdAt,
        createdBy,
        content: normalized
      };

      await this.#writeJson(this.#indexPath(templateId), { tenant, documentType });
      await this.#writeVersion(tenant, documentType, templateId, record);
      await this.#writeJson(path.join(this.#dir(tenant, documentType, templateId), 'meta.json'), {
        templateId,
        tenant,
        documentType,
        displayLabel: record.displayLabel,
        syntaxId,
        latestVersion: version,
        createdAt: meta ? meta.createdAt : createdAt,
        updatedAt: createdAt,
        createdBy
      });

      return { templateId, version, checksum, schemaVersion };
    });
  }

  async #transition(templateRef, tenant, nextState, { clearDefaultOnRetire = false } = {}) {
    const record = await this.get(templateRef, tenant);
    const documentType = record.documentType;
    if (record.state === nextState) return { ...record, isDefault: record.isDefault };
    if (record.state === 'retired') {
      throw new EngineError('TEMPLATE_RETIRED', `Template version ${record.version} is retired`);
    }
    if (record.state === 'published' && nextState !== 'retired') {
      throw new EngineError('TEMPLATE_IMMUTABLE', `Template version ${record.version} is already published`);
    }

    const { isDefault, tenant: _t, documentType: _d, ...persisted } = record;
    const updated = { ...persisted, state: nextState };
    await this.#writeVersion(tenant, documentType, record.templateId, updated);

    if (clearDefaultOnRetire) {
      const state = await this.#readState(tenant, documentType);
      if (state && state.defaultTemplateId === record.templateId && state.defaultVersion === record.version) {
        await this.#writeState(tenant, documentType, { defaultTemplateId: null, defaultVersion: null });
      }
    }
    return updated;
  }

  async publish(templateRef, tenant) {
    return this.mutex.run(`publish|${tenant}|${templateRef.templateId}`, () =>
      this.#transition(templateRef, tenant, 'published')
    );
  }

  async setDefault(templateRef, tenant) {
    const record = await this.get(templateRef, tenant);
    const documentType = record.documentType;
    return this.mutex.run(`default|${tenant}|${documentType}`, async () => {
      if (record.state !== 'published') {
        throw new EngineError(
          'TEMPLATE_NOT_PUBLISHED',
          `Cannot set a '${record.state}' version as default; publish it first`
        );
      }
      await this.#writeState(tenant, documentType, {
        defaultTemplateId: record.templateId,
        defaultVersion: record.version
      });
      return { ...record, isDefault: true };
    });
  }

  async retire(templateRef, tenant) {
    return this.mutex.run(`retire|${tenant}|${templateRef.templateId}`, () =>
      this.#transition(templateRef, tenant, 'retired', { clearDefaultOnRetire: true })
    );
  }

  async getDefault(tenant, documentType) {
    const state = await this.#readState(tenant, documentType);
    if (!state || !state.defaultTemplateId) return null;
    return { templateId: state.defaultTemplateId, version: state.defaultVersion };
  }

  /** Template counts per document type for the descriptors endpoint. */
  async countsByType(tenant) {
    const counts = new Map();
    const base = path.join(this.templatesRoot, tenant);
    let types = [];
    try {
      types = (await fs.readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const documentType of types) {
      const listing = await this.list(tenant, documentType, { limit: 500 });
      counts.set(documentType, listing.items.filter((item) => item.state !== 'retired').length);
    }
    return counts;
  }

  describe(record) {
    return { ...this.#publicRecord(record, record.state), summary: truncate(record.content || '', 120) };
  }
}

module.exports = { TemplateStore };
