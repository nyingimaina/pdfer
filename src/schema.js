'use strict';

const { EngineError } = require('./errors');
const { assertHint, DEFAULT_HINTS, isNumericType, isTemporalType } = require('./format');
const { DOCUMENT_TYPE_RE } = require('./util');

const DATA_TYPES = new Set([
  'string', 'html', 'number', 'money', 'date', 'datetime', 'boolean', 'object', 'collection'
]);

const RESERVED_ROOT_TOKENS = new Set(['generatedAt', 'documentType', 'title']);
const RESERVED_LOOP_VARIABLES = new Set([
  'forloop', 'for', 'if', 'elsif', 'else', 'unless', 'assign',
  'raw', 'endraw', 'comment', 'endcomment', 'endfor', 'endif', 'endunless'
]);
const MAX_DEPTH = 4;
const LOOP_VAR_RE = /^[a-z][a-zA-Z0-9_]{0,31}$/;

function schemaError(message, details) {
  return new EngineError('SCHEMA_INVALID', message, { details });
}

function assertString(value, label, { allowEmpty = false } = {}) {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw schemaError(`${label} must be a non-empty string`);
  }
}

/** Normalises a declared schema into an indexed tree. Throws SCHEMA_INVALID. */
function compileSchema(definition) {
  if (!definition || typeof definition !== 'object') {
    throw schemaError('Schema definition must be an object');
  }
  const { documentType, schemaVersion, root } = definition;
  if (typeof documentType !== 'string' || !DOCUMENT_TYPE_RE.test(documentType)) {
    throw schemaError(`documentType '${documentType}' does not match ${DOCUMENT_TYPE_RE}`);
  }
  if (!Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw schemaError('schemaVersion must be a positive integer');
  }
  if (!Array.isArray(root) || root.length === 0) {
    throw schemaError('root must be a non-empty array');
  }

  const byPath = new Map();
  const byToken = new Map();
  const loopVariables = new Map();
  const rootTokens = [];

  function registerPath(path, token, node) {
    if (byPath.has(path)) throw schemaError(`Duplicate path '${path}'`);
    byPath.set(path, node);
    if (byToken.has(token)) throw schemaError(`Duplicate token '${token}'`);
    byToken.set(token, node);
  }

  function build(defs, ctx) {
    if (ctx.depth > MAX_DEPTH) {
      throw schemaError(`Schema nesting deeper than ${MAX_DEPTH} levels at '${ctx.prefixPath}'`);
    }
    return defs.map((def) => {
      if (!def || typeof def !== 'object') throw schemaError('Placeholder descriptor must be an object');
      const name = def.name || null;
      assertString(def.displayLabel, `displayLabel for '${def.path}'`);

      const path = name ? `${ctx.prefixPath}${name}` : def.path;
      assertString(path, 'path');

      const dataType = def.dataType;
      if (!DATA_TYPES.has(dataType)) {
        throw schemaError(`Unknown dataType '${dataType}' for '${path}'`);
      }
      const isCollection = dataType === 'collection';
      if (Boolean(def.isCollection) !== isCollection) {
        throw schemaError(`isCollection must be ${isCollection} for dataType '${dataType}' ('${path}')`);
      }
      if (isCollection || dataType === 'object') {
        if (!Array.isArray(def.children) || def.children.length === 0) {
          throw schemaError(`'${path}' (${dataType}) must declare children`);
        }
      } else if (Array.isArray(def.children) && def.children.length) {
        throw schemaError(`'${path}' (${dataType}) must not declare children`);
      }

      let token;
      if (ctx.parentToken) {
        token = `${ctx.parentToken}.${name}`;
      } else {
        token = def.token || path;
      }
      if (!ctx.parentToken && RESERVED_ROOT_TOKENS.has(token)) {
        throw schemaError(`Token '${token}' is reserved and cannot be declared in a schema`);
      }

      const isRequired = def.isRequired !== undefined ? Boolean(def.isRequired) : false;
      const formatHint = def.formatHint === undefined ? null : def.formatHint;
      if (isTemporalType(dataType) || isNumericType(dataType)) {
        assertHint(dataType, formatHint || DEFAULT_HINTS[dataType]);
      } else if (formatHint !== null) {
        throw schemaError(`formatHint is not allowed on dataType '${dataType}' ('${path}')`);
      }

      if (def.sampleValue !== undefined) {
        validateSample(def.sampleValue, dataType, path);
      }

      const node = {
        path,
        token,
        name: name || (ctx.parentToken ? path.split('.').pop() : token),
        displayLabel: def.displayLabel,
        group: def.group || null,
        dataType,
        isCollection,
        isRequired,
        formatHint,
        sampleValue: def.sampleValue === undefined ? null : def.sampleValue,
        loopVariable: null,
        children: [],
        parentToken: ctx.parentToken || null
      };

      if (isCollection) {
        const loopVariable = def.loopVariable;
        if (typeof loopVariable !== 'string' || !LOOP_VAR_RE.test(loopVariable)) {
          throw schemaError(`loopVariable for '${path}' must match ${LOOP_VAR_RE}`);
        }
        if (RESERVED_LOOP_VARIABLES.has(loopVariable)) {
          throw schemaError(`loopVariable '${loopVariable}' is reserved`);
        }
        if (loopVariables.has(loopVariable)) {
          throw schemaError(`loopVariable '${loopVariable}' is declared more than once`);
        }
        loopVariables.set(loopVariable, node);
        node.loopVariable = loopVariable;
        node.children = build(def.children, {
          prefixPath: `${path}[].`,
          parentToken: loopVariable,
          depth: ctx.depth + 1
        });
      } else if (dataType === 'object') {
        node.children = build(def.children, {
          prefixPath: `${path}.`,
          parentToken: token,
          depth: ctx.depth + 1
        });
      }

      registerPath(path, token, node);
      if (!ctx.parentToken) rootTokens.push(token);
      return node;
    });
  }

  const nodes = build(root, { prefixPath: '', parentToken: '', depth: 1 });

  return {
    documentType,
    schemaVersion,
    root: nodes,
    byPath,
    byToken,
    loopVariables,
    rootTokens,
    sampleData: definition.sampleData || null,
    reservedTokens: RESERVED_ROOT_TOKENS,
    /** Palette view: flat list in declaration order. */
    flattened() {
      const out = [];
      const walk = (list) => {
        for (const node of list) {
          out.push(node);
          if (node.children.length) walk(node.children);
        }
      };
      walk(nodes);
      return out;
    }
  };
}

function validateSample(value, dataType, path) {
  if (value === null) {
    if (dataType !== 'collection' && dataType !== 'object') return;
  }
  switch (dataType) {
    case 'string':
    case 'html':
      if (typeof value !== 'string') throw schemaError(`sampleValue for '${path}' must be a string`);
      break;
    case 'number':
    case 'money':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw schemaError(`sampleValue for '${path}' must be a number (not a formatted string)`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') throw schemaError(`sampleValue for '${path}' must be a boolean`);
      break;
    case 'date':
    case 'datetime':
      if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
        throw schemaError(`sampleValue for '${path}' must be an ISO date string`);
      }
      break;
    case 'collection':
      if (value !== null && !Array.isArray(value)) {
        throw schemaError(`sampleValue for '${path}' must be null or an array`);
      }
      break;
    case 'object':
      if (value !== null && (typeof value !== 'object' || Array.isArray(value))) {
        throw schemaError(`sampleValue for '${path}' must be null or an object`);
      }
      break;
    default:
      break;
  }
}

class SchemaRegistry {
  constructor() {
    this.types = new Map();
  }

  register(definition) {
    const schema = compileSchema(definition);
    if (!this.types.has(schema.documentType)) {
      this.types.set(schema.documentType, { versions: new Map(), samples: new Map(), current: 0 });
    }
    const entry = this.types.get(schema.documentType);
    if (entry.versions.has(schema.schemaVersion)) {
      throw schemaError(`Schema ${schema.documentType} v${schema.schemaVersion} registered twice`);
    }
    entry.versions.set(schema.schemaVersion, schema);
    if (schema.sampleData) entry.samples.set(schema.schemaVersion, schema.sampleData);
    if (schema.schemaVersion > entry.current) entry.current = schema.schemaVersion;
    return schema;
  }

  has(documentType) {
    return this.types.has(documentType);
  }

  latestVersion(documentType) {
    const entry = this.types.get(documentType);
    return entry ? entry.current : null;
  }

  resolve(documentType, version) {
    const entry = this.types.get(documentType);
    if (!entry) {
      throw new EngineError('SCHEMA_VERSION_UNKNOWN', `Unknown document type '${documentType}'`, {
        details: { documentType }
      });
    }
    const wanted = version === undefined || version === null ? entry.current : Number(version);
    const schema = entry.versions.get(wanted);
    if (!schema) {
      throw new EngineError('SCHEMA_VERSION_UNKNOWN', `Unknown schema version ${wanted} for '${documentType}'`, {
        details: { documentType, schemaVersion: wanted }
      });
    }
    return schema;
  }

  assertNotEmpty() {
    if (!this.types.size) {
      throw new EngineError('SCHEMA_REGISTRY_EMPTY', 'No document types are registered');
    }
  }

  listDocumentTypes() {
    return [...this.types.entries()].map(([documentType, entry]) => ({
      documentType,
      schemaVersion: entry.current
    }));
  }
}

module.exports = {
  SchemaRegistry,
  compileSchema,
  DATA_TYPES,
  RESERVED_ROOT_TOKENS,
  RESERVED_LOOP_VARIABLES,
  MAX_DEPTH
};
