'use strict';

/**
 * Stable error codes (SPEC v1.1 §5). Codes are the ABI: messages may change,
 * codes and their HTTP statuses may not.
 */
const CODES = Object.freeze({
  REQUEST_INVALID: { status: 400, retriable: false },
  UNAUTHORIZED: { status: 401, retriable: false },
  RATE_LIMITED: { status: 429, retriable: true },
  REQUEST_TOO_LARGE: { status: 413, retriable: false },
  DATA_TOO_LARGE: { status: 413, retriable: false },
  OUTPUT_TOO_LARGE: { status: 500, retriable: false },
  TEMPLATE_NOT_FOUND: { status: 404, retriable: false },
  TEMPLATE_NOT_PUBLISHED: { status: 409, retriable: false },
  TEMPLATE_IMMUTABLE: { status: 409, retriable: false },
  TEMPLATE_TOO_LARGE: { status: 413, retriable: false },
  TEMPLATE_SYNTAX_ERROR: { status: 400, retriable: false },
  TEMPLATE_RETIRED: { status: 409, retriable: false },
  VERSION_CONFLICT: { status: 409, retriable: false },
  NO_DEFAULT_TEMPLATE: { status: 404, retriable: false },
  UNKNOWN_TOKEN: { status: 400, retriable: false },
  TYPE_MISMATCH: { status: 400, retriable: false },
  REQUIRED_PLACEHOLDER_MISSING: { status: 400, retriable: false },
  UNKNOWN_DATA_KEY: { status: 400, retriable: false },
  SCHEMA_VERSION_UNKNOWN: { status: 404, retriable: false },
  SCHEMA_VERSION_MISMATCH: { status: 400, retriable: false },
  SCHEMA_INVALID: { status: 500, retriable: false },
  SCHEMA_REGISTRY_EMPTY: { status: 500, retriable: false },
  ASSET_MISSING: { status: 404, retriable: false },
  ASSET_NOT_FOUND: { status: 404, retriable: false },
  ASSET_REJECTED: { status: 400, retriable: false },
  ASSET_TOO_LARGE: { status: 413, retriable: false },
  PAGINATION_LIMIT_EXCEEDED: { status: 400, retriable: false },
  TENANT_MISMATCH: { status: 409, retriable: false },
  INLINE_TEMPLATE_NOT_ALLOWED_IN_PRODUCTION: { status: 400, retriable: false },
  PREVIEW_SIDE_EFFECT_DENIED: { status: 400, retriable: false },
  RENDER_OPTION_UNSUPPORTED: { status: 400, retriable: false },
  UNSAFE_MARKUP: { status: 400, retriable: false },
  EXTERNAL_REFERENCE_REJECTED: { status: 400, retriable: false },
  FILTER_NOT_ALLOWED: { status: 400, retriable: false },
  TAG_NOT_ALLOWED: { status: 400, retriable: false },
  RENDERER_UNAVAILABLE: { status: 503, retriable: true },
  RENDER_TIMEOUT: { status: 504, retriable: true },
  RENDER_FAILED: { status: 502, retriable: true },
  RENDER_RESOURCE_FAILED: { status: 502, retriable: false },
  RENDER_QUEUE_FULL: { status: 503, retriable: true },
  OUTPUT_WRITE_FAILED: { status: 500, retriable: true },
  ARTIFACT_NOT_FOUND: { status: 404, retriable: false },
  JOB_NOT_FOUND: { status: 404, retriable: false },
  INTERNAL_ERROR: { status: 500, retriable: true }
});

class EngineError extends Error {
  constructor(code, message, options = {}) {
    super(message || code);
    this.name = 'EngineError';
    this.code = CODES[code] ? code : 'INTERNAL_ERROR';
    this.location = options.location || undefined;
    this.details = options.details || undefined;
    this.retriable = options.retriable !== undefined
      ? options.retriable
      : CODES[this.code].retriable;
    this.expose = true;
    if (options.cause) this.cause = options.cause;
  }

  get status() {
    return CODES[this.code].status;
  }

  toEnvelope(requestId) {
    const error = {
      code: this.code,
      message: this.message,
      retriable: this.retriable
    };
    if (this.location) error.location = this.location;
    const details = { ...(this.details || {}) };
    if (requestId) details.requestId = requestId;
    if (Object.keys(details).length) error.details = details;
    return { error };
  }
}

function isEngineError(value) {
  return value instanceof EngineError;
}

module.exports = { CODES, EngineError, isEngineError };
