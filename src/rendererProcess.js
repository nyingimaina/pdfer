'use strict';

const { spawn } = require('node:child_process');

/**
 * Supervises the embedded Gotenberg process (SPEC D-9, N26, N27).
 *
 * The renderer is bound to loopback, has JavaScript disabled, has both private
 * and public IP deny rules, and has the LibreOffice/PDF-engine routes disabled.
 * If it exits unexpectedly it is restarted with bounded exponential backoff.
 */
class RendererProcess {
  constructor({ config, logger }) {
    this.config = config.renderer;
    this.logger = logger;
    this.child = null;
    this.stopping = false;
    this.restartDelayMs = 1000;
    this.restartTimer = null;
    this.ready = false;
    this.crashes = 0;
  }

  args() {
    return [
      `--api-port=${this.config.port}`,
      '--api-bind-ip=127.0.0.1',
      '--api-timeout=120s',
      '--api-body-limit=96MB',
      '--api-disable-download-from',
      '--chromium-disable-javascript',
      '--chromium-deny-private-ips',
      '--chromium-deny-public-ips',
      '--chromium-restart-after=200',
      '--chromium-idle-shutdown-timeout=180s',
      '--chromium-max-concurrency=2',
      '--chromium-max-queue-size=8',
      '--libreoffice-disable-routes',
      '--pdfengines-disable-routes',
      '--webhook-disable',
      '--prometheus-disable-collect',
      '--log-level=warn',
      '--gotenberg-hide-banner',
      '--gotenberg-graceful-shutdown-duration=10s'
    ];
  }

  async start() {
    if (this.config.external) {
      this.logger.info({ renderer: this.config.baseUrl }, 'using external renderer');
      return;
    }

    await this.#spawn();
    const deadline = Date.now() + this.config.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.#probe()) {
        this.ready = true;
        this.logger.info({ port: this.config.port }, 'embedded renderer is ready');
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Embedded renderer did not become healthy within ${this.config.startTimeoutMs} ms`);
  }

  async #spawn() {
    this.child = spawn(this.config.bin, this.args(), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: '/tmp' }
    });

    this.child.stdout.on('data', (chunk) => {
      this.logger.debug({ renderer: chunk.toString().trim() }, 'renderer stdout');
    });
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      this.logger.debug({ renderer: text.slice(0, 500) }, 'renderer stderr');
    });
    this.child.on('error', (error) => {
      this.logger.error({ err: error.message }, 'renderer failed to start');
    });
    this.child.on('exit', (code, signal) => {
      this.ready = false;
      if (this.stopping) return;
      this.crashes += 1;
      this.logger.error({ code, signal, crashes: this.crashes }, 'renderer exited unexpectedly');
      this.restartTimer = setTimeout(async () => {
        try {
          await this.#spawn();
          const deadline = Date.now() + this.config.startTimeoutMs;
          while (Date.now() < deadline) {
            if (await this.#probe()) {
              this.ready = true;
              this.restartDelayMs = 1000;
              this.logger.info('renderer restarted');
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
          this.logger.error('renderer restarted but never became healthy');
        } catch (error) {
          this.logger.error({ err: error.message }, 'renderer restart failed');
        }
        this.restartDelayMs = Math.min(this.restartDelayMs * 2, 30000);
      }, this.restartDelayMs);
      this.restartTimer.unref?.();
    });
  }

  async #probe() {
    try {
      const response = await fetch(`${this.config.baseUrl}/health`, {
        signal: AbortSignal.timeout(2000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  isReady() {
    return this.config.external ? true : this.ready;
  }

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (!this.child) return;
    const child = this.child;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 10000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
  }
}

module.exports = { RendererProcess };
