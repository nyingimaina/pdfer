'use strict';

const { spawn } = require('node:child_process');

/**
 * Decides whether an idle renderer should be stopped.
 *
 * Exported so the rule can be tested without spawning Chromium.
 */
function shouldStopIdle({ enabled, now, lastBusyAt, idleSeconds, active, queued }) {
  if (!enabled) return false;
  if (!idleSeconds || idleSeconds <= 0) return false;
  if (active > 0 || queued > 0) return false;
  return now - lastBusyAt >= idleSeconds * 1000;
}

/**
 * Supervises the embedded Gotenberg process.
 *
 * - starts it lazily if `PDFER_RENDERER_IDLE_STOP_SECONDS` stopped it;
 * - restarts it with bounded backoff after a crash;
 * - optionally stops it after a period with no renders, so idle memory drops to
 *   the engine process only (~20-50 MB). The next render starts it again and
 *   pays a ~0.5-1.5 s cold start.
 */
class RendererProcess {
  constructor({ config, logger, renderer }) {
    this.config = config.renderer;
    this.logger = logger;
    this.renderer = renderer;
    this.child = null;
    this.stopping = false;
    this.idleStopping = false;
    this.starting = null;
    this.restartTimer = null;
    this.idleTimer = null;
    this.ready = false;
    this.idle = false;
    this.crashes = 0;
    this.restartDelayMs = 1000;
    this.lastBusyAt = Date.now();
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

    await this.#spawnAndWait();
    this.logger.info({ port: this.config.port }, 'embedded renderer is ready');
    this.#startIdleWatchdog();
  }

  /** Starts the renderer if it is not running. Safe to call concurrently. */
  async ensureStarted() {
    if (this.config.external) return;
    if (this.ready && this.child) return;
    if (this.starting) return this.starting;

    this.starting = (async () => {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      this.idleStopping = false;
      this.idle = false;
      this.logger.info('starting the renderer on demand');
      await this.#spawnAndWait();
      this.lastBusyAt = Date.now();
      this.logger.info('renderer is ready');
    })().finally(() => {
      this.starting = null;
    });

    return this.starting;
  }

  /** Called by the renderer around every conversion. */
  noteActivity() {
    this.lastBusyAt = Date.now();
  }

  isReady() {
    return this.config.external ? true : this.ready;
  }

  /** True when the renderer was stopped on purpose and can be started again. */
  isIdle() {
    return !this.config.external && this.idle && !this.ready;
  }

  async #spawnAndWait() {
    await this.#spawn();
    const deadline = Date.now() + this.config.startTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.#probe()) {
        this.ready = true;
        this.idle = false;
        this.restartDelayMs = 1000;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Renderer did not become healthy within ${this.config.startTimeoutMs} ms`);
  }

  #startIdleWatchdog() {
    if (!this.config.idleStopSeconds || this.idleTimer) return;
    const pollSeconds = Math.max(5, Math.min(30, Math.floor(this.config.idleStopSeconds / 2)));
    this.idleTimer = setInterval(() => {
      this.#stopIfIdle().catch((error) =>
        this.logger.error({ err: error.message }, 'idle shutdown check failed')
      );
    }, pollSeconds * 1000);
    this.idleTimer.unref?.();
    this.logger.info(
      { idleStopSeconds: this.config.idleStopSeconds },
      'renderer idle shutdown enabled'
    );
  }

  async #stopIfIdle() {
    if (!this.ready || !this.child || this.starting) return;
    const active = this.renderer ? this.renderer.activeRenders : 0;
    const queued = this.renderer ? this.renderer.queueDepth : 0;
    const stop = shouldStopIdle({
      enabled: Boolean(this.config.idleStopSeconds),
      now: Date.now(),
      lastBusyAt: this.lastBusyAt,
      idleSeconds: this.config.idleStopSeconds,
      active,
      queued
    });
    if (!stop) return;

    this.idleStopping = true;
    this.ready = false;
    this.idle = true;
    this.logger.info(
      { idleSeconds: this.config.idleStopSeconds },
      'stopping the renderer after an idle period'
    );
    this.child.kill('SIGTERM');
  }

  async #spawn() {
    // A child that is still shutting down (idle stop, crash) must finish before
    // a new one is started, or the port stays bound and the spawn silently no-ops.
    if (this.child) {
      const existing = this.child;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000);
        existing.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

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
      this.child = null;
      this.ready = false;

      if (this.stopping) return;
      if (this.idleStopping) {
        this.idleStopping = false;
        this.logger.info({ code, signal }, 'renderer stopped for idleness');
        return;
      }

      this.crashes += 1;
      this.logger.error({ code, signal, crashes: this.crashes }, 'renderer exited unexpectedly');
      this.restartTimer = setTimeout(async () => {
        try {
          await this.#spawnAndWait();
          this.logger.info('renderer restarted');
        } catch (error) {
          this.logger.error({ err: error.message }, 'renderer restart failed');
          this.restartDelayMs = Math.min((this.restartDelayMs || 1000) * 2, 30000);
        }
      }, this.restartDelayMs || 1000);
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

  async stop() {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    if (this.idleTimer) clearInterval(this.idleTimer);
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

module.exports = { RendererProcess, shouldStopIdle };
