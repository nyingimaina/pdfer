'use strict';

const { EngineError } = require('./errors');
const { escapeHtml, isPlainObject } = require('./util');
const { formatScalar, coerceNumericInput, isNumericType, isTemporalType } = require('./format');

/**
 * DataBinder (SPEC §6.3 + v1.1 N1/N3/N5).
 * Validates raw JSON against the schema and produces the presentation model.
 * No totals, no sorting, no filtering, no currency maths (B4).
 */
class Binder {
  constructor({ maxRows = 50000 } = {}) {
    this.maxRows = maxRows;
  }

  bind(rawData, schema) {
    const issues = [];
    let rows = 0;

    if (!isPlainObject(rawData)) {
      throw new EngineError('REQUEST_INVALID', '`data` must be a JSON object', {
        details: { received: rawData === null ? 'null' : typeof rawData }
      });
    }

    const model = {};
    const known = new Set(schema.root.map((node) => node.name));
    for (const key of Object.keys(rawData)) {
      if (!known.has(key)) {
        issues.push({
          code: 'UNKNOWN_DATA_KEY',
          token: key,
          message: `Unknown data key '${key}' is not declared in schema ${schema.documentType} v${schema.schemaVersion}`
        });
      }
    }

    for (const node of schema.root) {
      const value = Object.prototype.hasOwnProperty.call(rawData, node.name)
        ? rawData[node.name]
        : undefined;
      const bound = this.#bindNode(node, value, issues, () => ++rows);
      if (bound !== undefined) model[node.name] = bound;
    }

    if (rows > this.maxRows) {
      throw new EngineError(
        'PAGINATION_LIMIT_EXCEEDED',
        `Collection rows (${rows}) exceed the configured maximum of ${this.maxRows}`,
        { details: { rows, maximum: this.maxRows } }
      );
    }

    if (issues.length) {
      const first = issues[0];
      throw new EngineError(first.code, first.message, { details: { issues } });
    }

    return model;
  }

  #bindNode(node, value, issues, tick) {
    const absent = value === undefined || value === null;

    if (absent) {
      if (node.isRequired) {
        issues.push({
          code: 'REQUIRED_PLACEHOLDER_MISSING',
          token: node.token,
          message: `Required value '${node.token}' is missing`
        });
        return undefined;
      }
      return null;
    }

    switch (node.dataType) {
      case 'string':
      case 'html': {
        if (typeof value !== 'string') return this.#mismatch(node, value, 'string', issues);
        const normalised = value.normalize('NFC');
        // Escape by default (N1); `html` fields are explicitly the caller's responsibility.
        return node.dataType === 'html' ? normalised : escapeHtml(normalised);
      }

      case 'number':
      case 'money': {
        const numeric = coerceNumericInput(value);
        if (numeric === undefined) return this.#mismatch(node, value, 'number', issues);
        return formatScalar(node.dataType, numeric, node.formatHint);
      }

      case 'date':
      case 'datetime': {
        if (typeof value !== 'string') return this.#mismatch(node, value, 'ISO date string', issues);
        try {
          return formatScalar(node.dataType, value, node.formatHint);
        } catch {
          return this.#mismatch(node, value, node.dataType === 'date' ? 'date' : 'datetime', issues);
        }
      }

      case 'boolean': {
        if (typeof value !== 'boolean') return this.#mismatch(node, value, 'boolean', issues);
        return value;
      }

      case 'collection': {
        if (!Array.isArray(value)) return this.#mismatch(node, value, 'array', issues);
        const out = [];
        for (let index = 0; index < value.length; index++) {
          const item = value[index];
          tick();
          if (!isPlainObject(item)) {
            issues.push({
              code: 'TYPE_MISMATCH',
              token: `${node.token}[${index}]`,
              message: `'${node.token}[${index}]' must be an object`,
              expectedType: 'object',
              receivedType: Array.isArray(item) ? 'array' : typeof item
            });
            continue;
          }
          const childKnown = new Set(node.children.map((child) => child.name));
          for (const key of Object.keys(item)) {
            if (!childKnown.has(key)) {
              issues.push({
                code: 'UNKNOWN_DATA_KEY',
                token: `${node.token}[${index}].${key}`,
                message: `Unknown data key '${key}' in '${node.token}[${index}]'`
              });
            }
          }
          const boundItem = {};
          for (const child of node.children) {
            const childValue = Object.prototype.hasOwnProperty.call(item, child.name)
              ? item[child.name]
              : undefined;
            const boundChild = this.#bindNode(child, childValue, issues, tick);
            if (boundChild !== undefined) boundItem[child.name] = boundChild;
          }
          out.push(boundItem);
        }
        return out;
      }

      case 'object': {
        if (!isPlainObject(value)) return this.#mismatch(node, value, 'object', issues);
        const childKnown = new Set(node.children.map((child) => child.name));
        for (const key of Object.keys(value)) {
          if (!childKnown.has(key)) {
            issues.push({
              code: 'UNKNOWN_DATA_KEY',
              token: `${node.token}.${key}`,
              message: `Unknown data key '${key}' in '${node.token}'`
            });
          }
        }
        const out = {};
        for (const child of node.children) {
          const childValue = Object.prototype.hasOwnProperty.call(value, child.name)
            ? value[child.name]
            : undefined;
          const boundChild = this.#bindNode(child, childValue, issues, tick);
          if (boundChild !== undefined) out[child.name] = boundChild;
        }
        return out;
      }

      default:
        return this.#mismatch(node, value, node.dataType, issues);
    }
  }

  #mismatch(node, value, expectedType, issues) {
    const receivedType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    issues.push({
      code: 'TYPE_MISMATCH',
      token: node.token,
      message: `'${node.token}' expects ${expectedType}, received ${receivedType}`,
      expectedType,
      receivedType
    });
    return undefined;
  }
}

/** Deterministic sample payload derived from the schema (SPEC §9 deviation). */
function buildSampleData(schema, { collectionRows = 2 } = {}) {
  const buildNode = (node, index = 0) => {
    switch (node.dataType) {
      case 'collection':
        return Array.from({ length: collectionRows }, (_, rowIndex) => {
          const row = {};
          for (const child of node.children) {
            let value = buildNode(child, rowIndex);
            if (rowIndex > 0 && typeof value === 'string') value = `${value} ${rowIndex + 1}`;
            row[child.name] = value;
          }
          return row;
        });
      case 'object': {
        const out = {};
        for (const child of node.children) out[child.name] = buildNode(child, index);
        return out;
      }
      default:
        return node.sampleValue;
    }
  };

  if (schema.sampleData) return schema.sampleData;
  const out = {};
  for (const node of schema.root) out[node.name] = buildNode(node);
  return out;
}

module.exports = { Binder, buildSampleData };
