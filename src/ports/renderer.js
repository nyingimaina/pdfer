'use strict';

const { PDFDocument } = require('pdf-lib');
const { EngineError } = require('../errors');

/**
 * Gotenberg (Chromium) adapter — SPEC §9, ADR-2, ADR-10.
 * One implementation. The port exists for tests, timeouts and failure isolation.
 */

const DEFAULTS = {
  preferCssPageSize: true,
  landscape: false,
  printBackground: true,
  scale: 1,
  paperWidth: '210mm',
  paperHeight: '297mm',
  nativePageRanges: null,
  waitForExpression: null,
  waitDelay: null,
  failOnHttpStatusCodes: [499, 500, 501, 502, 503, 504],
  metadata: {}
};

function mmToInches(mm) {
  return (Number(mm) / 25.4).toFixed(4);
}

class Semaphore {
  constructor(max, maxQueue) {
    this.max = max;
    this.maxQueue = maxQueue;
    this.active = 0;
    this.queue = [];
  }

  get depth() {
    return this.queue.length;
  }

  get inFlight() {
    return this.active;
  }

  async acquire() {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    if (this.queue.length >= this.maxQueue) {
      throw new EngineError('RENDER_QUEUE_FULL', 'Render queue is full; retry with backoff', {
        details: { active: this.active, queued: this.queue.length }
      });
    }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
    const next = this.queue.shift();
    if (next) next();
  }
}

class GotenbergRenderer {
  constructor({
    baseUrl = 'http://127.0.0.1:3001',
    timeoutMs = 60000,
    retries = 2,
    maxConcurrency = 2,
    maxQueue = 32,
    maxOutputBytes = 100 * 1024 * 1024,
    javascriptEnabled = false,
    logger
  }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.maxOutputBytes = maxOutputBytes;
    this.javascriptEnabled = javascriptEnabled;
    this.logger = logger;
    this.semaphore = new Semaphore(maxConcurrency, maxQueue);
    this.healthCache = { at: 0, value: null };
  }

  get queueDepth() {
    return this.semaphore.depth;
  }

  get activeRenders() {
    return this.semaphore.inFlight;
  }

  async render({ html, assets, headerHtml, footerHtml, options, signal }) {
    const opts = { ...DEFAULTS, ...(options || {}) };
    for (const key of Object.keys(opts)) {
      if (opts[key] === undefined) opts[key] = DEFAULTS[key];
    }
    if (opts.failOnHttpStatusCodes === null) opts.failOnHttpStatusCodes = DEFAULTS.failOnHttpStatusCodes;

    if (opts.waitForExpression && !this.javascriptEnabled) {
      throw new EngineError(
        'RENDER_OPTION_UNSUPPORTED',
        '`waitForExpression` requires JavaScript, which is disabled for security (SPEC §3.10)'
      );
    }

    let lastError = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.#attempt({ html, assets, headerHtml, footerHtml, opts, signal });
      } catch (error) {
        lastError = error;
        const retriable = error instanceof EngineError && error.retriable;
        if (!retriable || attempt === this.retries || (signal && signal.aborted)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  async #attempt({ html, assets, headerHtml, footerHtml, opts, signal }) {
    await this.semaphore.acquire();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) {
        this.semaphore.release();
        throw new EngineError('RENDER_TIMEOUT', 'Render cancelled');
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const form = new FormData();
      form.append('files', new Blob([Buffer.from(html, 'utf8')], { type: 'text/html' }), 'index.html');
      for (const asset of assets || []) {
        form.append(
          'files',
          new Blob([asset.bytes], { type: asset.mimeType || 'application/octet-stream' }),
          asset.path
        );
      }
      if (headerHtml) form.append('files', new Blob([headerHtml], { type: 'text/html' }), 'header.html');
      if (footerHtml) form.append('files', new Blob([footerHtml], { type: 'text/html' }), 'footer.html');

      form.append('preferCssPageSize', String(opts.preferCssPageSize));
      form.append('printBackground', String(opts.printBackground));
      form.append('landscape', String(opts.landscape));
      form.append('scale', String(opts.scale));
      form.append('failOnHttpStatusCodes', JSON.stringify(opts.failOnHttpStatusCodes));
      form.append('metadata', JSON.stringify(opts.metadata || {}));

      if (!opts.preferCssPageSize) {
        form.append('paperWidth', String(opts.paperWidth));
        form.append('paperHeight', String(opts.paperHeight));
        form.append('marginTop', mmToInches(opts.marginTop ?? 0));
        form.append('marginBottom', mmToInches(opts.marginBottom ?? 0));
        form.append('marginLeft', mmToInches(opts.marginLeft ?? 0));
        form.append('marginRight', mmToInches(opts.marginRight ?? 0));
      } else if (opts.marginTop !== undefined || opts.marginBottom !== undefined) {
        // Explicit margins are still honoured when the caller asks for them.
        if (opts.marginTop !== undefined) form.append('marginTop', mmToInches(opts.marginTop));
        if (opts.marginBottom !== undefined) form.append('marginBottom', mmToInches(opts.marginBottom));
        if (opts.marginLeft !== undefined) form.append('marginLeft', mmToInches(opts.marginLeft));
        if (opts.marginRight !== undefined) form.append('marginRight', mmToInches(opts.marginRight));
      }
      if (opts.nativePageRanges) form.append('nativePageRanges', String(opts.nativePageRanges));
      if (opts.waitDelay) form.append('waitDelay', String(opts.waitDelay));
      if (opts.waitForExpression) form.append('waitForExpression', String(opts.waitForExpression));

      let response;
      try {
        response = await fetch(`${this.baseUrl}/forms/chromium/convert/html`, {
          method: 'POST',
          body: form,
          signal: controller.signal
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new EngineError('RENDER_TIMEOUT', `Renderer exceeded ${this.timeoutMs} ms`);
        }
        throw new EngineError('RENDERER_UNAVAILABLE', 'Renderer is unreachable', { cause: error });
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        if (response.status === 503) {
          throw new EngineError('RENDERER_UNAVAILABLE', 'Renderer is not ready', { details: { status: 503 } });
        }
        throw new EngineError('RENDER_FAILED', `Renderer returned HTTP ${response.status}`, {
          details: { status: response.status, detail: detail.slice(0, 500) }
        });
      }

      const contentType = response.headers.get('content-type') || '';
      const bytes = Buffer.from(await response.arrayBuffer());
      if (!/application\/pdf/.test(contentType) || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
        throw new EngineError('RENDER_FAILED', 'Renderer did not return a PDF', {
          details: { contentType: contentType.slice(0, 80) }
        });
      }
      if (bytes.length === 0) {
        throw new EngineError('RENDER_FAILED', 'Renderer returned an empty document');
      }
      if (bytes.length > this.maxOutputBytes) {
        throw new EngineError('OUTPUT_TOO_LARGE', `PDF exceeds ${this.maxOutputBytes} bytes`, {
          details: { byteLength: bytes.length, maximum: this.maxOutputBytes }
        });
      }

      let pageCount;
      try {
        const doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
        pageCount = doc.getPageCount();
      } catch (error) {
        throw new EngineError('RENDER_FAILED', 'Renderer produced an unreadable PDF', { cause: error });
      }
      if (!pageCount || pageCount < 1) {
        throw new EngineError('RENDER_FAILED', 'Rendered PDF has no pages');
      }
      return { bytes, pageCount };
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      this.semaphore.release();
    }
  }

  async health({ force = false } = {}) {
    const now = Date.now();
    if (!force && this.healthCache.value && now - this.healthCache.at < 2000) {
      return this.healthCache.value;
    }
    let value;
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        signal: AbortSignal.timeout(3000)
      });
      if (!response.ok) throw new Error(`health ${response.status}`);
      const body = await response.json().catch(() => ({}));
      let version = null;
      try {
        const versionResponse = await fetch(`${this.baseUrl}/version`, {
          signal: AbortSignal.timeout(3000)
        });
        if (versionResponse.ok) version = (await versionResponse.text()).trim();
      } catch {
        /* version is advisory */
      }
      value = { ok: body.status !== 'down', status: body.status || 'up', version };
    } catch {
      value = { ok: false, status: 'down', version: null };
    }
    this.healthCache = { at: now, value };
    return value;
  }
}

module.exports = { GotenbergRenderer, mmToInches, Semaphore, DEFAULTS };
