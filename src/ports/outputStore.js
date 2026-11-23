'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { EngineError } = require('../errors');
const { randomId, sanitizeFileName } = require('../util');

/**
 * Filesystem OutputStore (SPEC §6.6). Only ever called in production mode.
 *
 *   artifacts/<tenant>/<handle>.pdf
 *   artifacts/<tenant>/<handle>.json    { fileName, byteLength, contentType, provenance, createdAt }
 */
class OutputStore {
  constructor({ root, clock }) {
    this.root = root;
    this.clock = clock;
  }

  get artifactsRoot() {
    return path.join(this.root, 'artifacts');
  }

  async init() {
    await fsp.mkdir(this.artifactsRoot, { recursive: true });
  }

  #tenantDir(tenant) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant)) {
      throw new EngineError('REQUEST_INVALID', `Invalid tenant '${tenant}'`);
    }
    return path.join(this.artifactsRoot, tenant);
  }

  async save(tenant, { fileName, bytes, contentType = 'application/pdf', provenance }) {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new EngineError('INTERNAL_ERROR', 'Refusing to store an empty artifact');
    }
    const handle = randomId('art_');
    const dir = this.#tenantDir(tenant);
    await fsp.mkdir(dir, { recursive: true });

    const safeName = sanitizeFileName(fileName);
    const tmp = path.join(dir, `${handle}.pdf.tmp`);
    await fsp.writeFile(tmp, bytes);
    await fsp.rename(tmp, path.join(dir, `${handle}.pdf`));

    const meta = {
      handle,
      tenant,
      fileName: safeName,
      contentType,
      byteLength: bytes.length,
      provenance: provenance || null,
      createdAt: this.clock.now()
    };
    await fsp.writeFile(path.join(dir, `${handle}.json`), JSON.stringify(meta, null, 2), 'utf8');
    return meta;
  }

  async stat(handle, tenant) {
    if (typeof handle !== 'string' || !/^art_[a-f0-9]{32}$/.test(handle)) {
      throw new EngineError('ARTIFACT_NOT_FOUND', 'Unknown artifact handle');
    }
    try {
      const raw = await fsp.readFile(path.join(this.#tenantDir(tenant), `${handle}.json`), 'utf8');
      return JSON.parse(raw);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new EngineError('ARTIFACT_NOT_FOUND', 'Unknown artifact handle');
      }
      throw error;
    }
  }

  async open(handle, tenant) {
    const meta = await this.stat(handle, tenant);
    const file = path.join(this.#tenantDir(tenant), `${handle}.pdf`);
    await fsp.access(file);
    return { meta, stream: fs.createReadStream(file) };
  }

  async read(handle, tenant) {
    const meta = await this.stat(handle, tenant);
    const bytes = await fsp.readFile(path.join(this.#tenantDir(tenant), `${handle}.pdf`));
    return { meta, bytes };
  }

  /**
   * Deletes artifacts (and their metadata) older than `maxAgeDays`.
   * Returns the number removed and the bytes reclaimed.
   */
  async sweep({ maxAgeDays, now = Date.now(), logger } = {}) {
    if (!maxAgeDays || maxAgeDays <= 0) return { removed: 0, bytes: 0 };
    const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    let bytes = 0;

    let tenants = [];
    try {
      tenants = (await fsp.readdir(this.artifactsRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (error.code === 'ENOENT') return { removed: 0, bytes: 0 };
      throw error;
    }

    for (const tenant of tenants) {
      const dir = path.join(this.artifactsRoot, tenant);
      let files = [];
      try {
        files = await fsp.readdir(dir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith('art_') || !file.endsWith('.json')) continue;
        const metaPath = path.join(dir, file);
        try {
          const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
          const created = Date.parse(meta.createdAt);
          if (!Number.isFinite(created) || created >= cutoff) continue;
          const pdfPath = path.join(dir, file.replace(/\.json$/, '.pdf'));
          let size = 0;
          try {
            const stat = await fsp.stat(pdfPath);
            size = stat.size;
          } catch {
            /* pdf already gone */
          }
          await fsp.rm(pdfPath, { force: true });
          await fsp.rm(metaPath, { force: true });
          removed += 1;
          bytes += size;
        } catch {
          /* skip unreadable entries */
        }
      }
    }

    if (removed && logger) {
      logger.info({ removed, bytes, maxAgeDays }, 'artifact retention sweep');
    }
    return { removed, bytes };
  }
}

module.exports = { OutputStore };
