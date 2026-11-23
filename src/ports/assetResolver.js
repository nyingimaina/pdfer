'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { EngineError } = require('../errors');
const { safeRelativePath, sha256, randomId } = require('../util');

/**
 * Filesystem AssetResolver / AssetStore (SPEC §6.5, v1.1 §4.4).
 *
 *   assets/<tenant>/<assetRef>/_meta.json   { path, mimeType, sha256, size }
 *   assets/<tenant>/<assetRef>/<path>
 *
 * The resolver can only read inside the tenant subtree; `..`, absolute paths
 * and URLs are rejected before any filesystem call.
 */
class AssetResolver {
  constructor({ root, maxAssetBytes = 10 * 1024 * 1024, maxBundleBytes = 64 * 1024 * 1024, maxAssets = 256 }) {
    this.root = root;
    this.maxAssetBytes = maxAssetBytes;
    this.maxBundleBytes = maxBundleBytes;
    this.maxAssets = maxAssets;
    this.index = new Map();
  }

  get assetsRoot() {
    return path.join(this.root, 'assets');
  }

  async init() {
    await fs.mkdir(this.assetsRoot, { recursive: true });
  }

  #tenantRoot(tenant) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tenant)) {
      throw new EngineError('ASSET_REJECTED', `Invalid tenant '${tenant}'`);
    }
    return path.join(this.assetsRoot, tenant);
  }

  async #ensureIndex(tenant) {
    if (this.index.has(tenant)) return this.index.get(tenant);
    const byPath = new Map();
    const base = this.#tenantRoot(tenant);
    let refs = [];
    try {
      refs = (await fs.readdir(base, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const assetRef of refs) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(base, assetRef, '_meta.json'), 'utf8'));
        byPath.set(meta.path, { ...meta, assetRef });
      } catch {
        /* ignore unreadable entries */
      }
    }
    this.index.set(tenant, byPath);
    return byPath;
  }

  async register(tenant, { path: assetPath, bytes, mimeType }) {
    const normalized = safeRelativePath(assetPath);
    if (!normalized) {
      throw new EngineError('ASSET_REJECTED', `Unsafe asset path '${assetPath}'`, {
        details: { path: assetPath }
      });
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new EngineError('REQUEST_INVALID', 'Asset body must be non-empty binary data');
    }
    if (bytes.length > this.maxAssetBytes) {
      throw new EngineError('ASSET_TOO_LARGE', `Asset '${normalized}' exceeds ${this.maxAssetBytes} bytes`, {
        details: { size: bytes.length, maximum: this.maxAssetBytes }
      });
    }
    const byPath = await this.#ensureIndex(tenant);
    if (!byPath.has(normalized) && byPath.size >= this.maxAssets) {
      throw new EngineError('ASSET_TOO_LARGE', `Asset count exceeds ${this.maxAssets}`);
    }

    const assetRef = randomId('ast_');
    const digest = sha256(bytes);
    const dir = path.join(this.#tenantRoot(tenant), assetRef);
    await fs.mkdir(dir, { recursive: true });
    const target = path.join(dir, normalized);
    if (!target.startsWith(dir + path.sep)) {
      throw new EngineError('ASSET_REJECTED', 'Resolved path escaped the asset root');
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);

    const meta = {
      assetRef,
      path: normalized,
      mimeType: mimeType || 'application/octet-stream',
      sha256: 'sha256:' + digest,
      size: bytes.length
    };
    await fs.writeFile(path.join(dir, '_meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    byPath.set(normalized, meta);
    return meta;
  }

  async list(tenant) {
    const byPath = await this.#ensureIndex(tenant);
    return [...byPath.values()];
  }

  async has(tenant, assetPath) {
    const normalized = safeRelativePath(assetPath);
    if (!normalized) return false;
    const byPath = await this.#ensureIndex(tenant);
    return byPath.has(normalized);
  }

  /** Removes one asset (and its stored bytes) from the tenant library. */
  async remove(tenant, assetPath) {
    const normalized = safeRelativePath(assetPath);
    if (!normalized) {
      throw new EngineError('ASSET_REJECTED', `Unsafe asset path '${assetPath}'`, {
        details: { path: assetPath }
      });
    }
    const byPath = await this.#ensureIndex(tenant);
    const indexed = byPath.get(normalized);
    if (!indexed) {
      throw new EngineError('ASSET_NOT_FOUND', `Asset '${normalized}' is not registered for this tenant`, {
        details: { path: normalized }
      });
    }
    await fs.rm(path.join(this.#tenantRoot(tenant), indexed.assetRef), {
      recursive: true,
      force: true
    });
    byPath.delete(normalized);
    return { path: normalized, assetRef: indexed.assetRef, removed: true };
  }

  /** Resolves the request's asset bundle entries into bytes for the renderer. */
  async bundle(tenant, entries) {
    const byPath = await this.#ensureIndex(tenant);
    const resolved = [];
    let total = 0;
    const seen = new Set();

    for (const entry of entries || []) {
      if (!entry || typeof entry !== 'object') {
        throw new EngineError('REQUEST_INVALID', 'Asset entries must be objects');
      }
      const normalized = safeRelativePath(entry.path);
      if (!normalized) {
        throw new EngineError('ASSET_REJECTED', `Unsafe asset path '${entry.path}'`, {
          details: { path: entry.path }
        });
      }
      const indexed = entry.assetRef
        ? byPath.get(normalized) && byPath.get(normalized).assetRef === entry.assetRef
          ? byPath.get(normalized)
          : null
        : byPath.get(normalized);

      if (!indexed) {
        throw new EngineError('ASSET_MISSING', `Asset '${normalized}' is not registered for this tenant`, {
          details: { path: normalized, assetRef: entry.assetRef || null }
        });
      }
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      const bytes = await fs.readFile(
        path.join(this.#tenantRoot(tenant), indexed.assetRef, indexed.path)
      );
      total += bytes.length;
      if (total > this.maxBundleBytes) {
        throw new EngineError('ASSET_TOO_LARGE', `Asset bundle exceeds ${this.maxBundleBytes} bytes`, {
          details: { total, maximum: this.maxBundleBytes }
        });
      }
      resolved.push({
        path: normalized,
        mimeType: entry.mimeType || indexed.mimeType,
        bytes,
        sha256: indexed.sha256
      });
    }
    return resolved;
  }
}

module.exports = { AssetResolver };
