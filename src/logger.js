'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function createLogger(level = 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, payload, message) => {
    if (LEVELS[lvl] < threshold) return;
    const entry = {
      level: lvl,
      time: new Date().toISOString(),
      ...(message ? { msg: message } : {}),
      ...(payload && typeof payload === 'object' ? payload : { msg: String(payload ?? '') })
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  };
  return {
    level,
    debug: (payload, message) => write('debug', payload, message),
    info: (payload, message) => write('info', payload, message),
    warn: (payload, message) => write('warn', payload, message),
    error: (payload, message) => write('error', payload, message)
  };
}

module.exports = { createLogger };
