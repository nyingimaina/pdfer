'use strict';

/**
 * Deterministic, locale-free formatting (SPEC v1.1 §3.8).
 *
 * Numeric hints are .NET-style patterns: literal prefix/suffix plus a core of
 * '#', '0', ',' and '.'. Grouping occurs only when ',' is present. Rounding is
 * half-away-from-zero, computed on the shortest round-trip decimal
 * representation so results are identical on every JS engine and OS.
 *
 * Date hints use ICU tokens (yyyy, MM, dd, HH, mm, ss) in UTC, always.
 */

const NUMERIC_CORE = /[#0][#0,]*(?:\.[#0]+)?/;

function parseNumericPattern(hint) {
  const match = NUMERIC_CORE.exec(hint);
  if (!match) {
    throw new Error(`Invalid numeric formatHint '${hint}': no digit pattern found`);
  }
  const core = match[0];
  const intSection = core.split('.')[0];
  const decSection = core.includes('.') ? core.split('.')[1] : '';
  return {
    prefix: hint.slice(0, match.index),
    suffix: hint.slice(match.index + core.length),
    grouping: intSection.includes(','),
    minIntDigits: (intSection.match(/0/g) || []).length,
    minDecimals: (decSection.match(/0/g) || []).length,
    maxDecimals: (decSection.match(/[0#]/g) || []).length
  };
}

function toDecimalParts(value) {
  let text = value.toString();
  let sign = 1;
  if (text.startsWith('-')) {
    sign = -1;
    text = text.slice(1);
  }
  let exponent = 0;
  const eIdx = text.indexOf('e');
  if (eIdx >= 0) {
    exponent = Number.parseInt(text.slice(eIdx + 1), 10);
    text = text.slice(0, eIdx);
  }
  const dot = text.indexOf('.');
  const intPart = dot >= 0 ? text.slice(0, dot) : text;
  const fracPart = dot >= 0 ? text.slice(dot + 1) : '';
  return {
    sign,
    digits: (intPart + fracPart) || '0',
    scale: fracPart.length - exponent
  };
}

function roundFixed(value, decimals) {
  const { sign, digits, scale } = toDecimalParts(value);
  let magnitude = BigInt(digits);
  const shift = decimals - scale;
  if (shift >= 0) {
    magnitude *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = magnitude / divisor;
    const remainder = magnitude % divisor;
    magnitude = remainder * 2n >= divisor ? quotient + 1n : quotient;
  }
  const padded = magnitude.toString().padStart(decimals + 1, '0');
  const intPart = padded.slice(0, padded.length - decimals);
  const fracPart = decimals ? padded.slice(padded.length - decimals) : '';
  const isZero = magnitude === 0n;
  return { sign: isZero ? 1 : sign, intPart, fracPart, isZero };
}

function formatNumber(value, hint) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Cannot format non-finite number: ${value}`);
  }
  const pattern = parseNumericPattern(hint);
  const { sign, intPart, fracPart } = roundFixed(value, pattern.maxDecimals);

  let fraction = fracPart;
  while (fraction.length > pattern.minDecimals && fraction.endsWith('0')) {
    fraction = fraction.slice(0, -1);
  }

  let integer = intPart.replace(/^0+(?=\d)/, '');
  if (integer.length < pattern.minIntDigits) {
    integer = integer.padStart(pattern.minIntDigits, '0');
  }
  if (pattern.grouping) {
    integer = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  const body = fraction ? `${integer}.${fraction}` : integer;
  return `${pattern.prefix}${sign < 0 ? '-' : ''}${body}${pattern.suffix}`;
}

const DATE_TOKEN_RE = /yyyy|yy|MM|dd|HH|mm|ss|M|d|H/g;

function parseTemporal(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?Z)?$/.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m.map((v) => (v === undefined ? 0 : v));
  const parts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(s || 0),
    hasTime: Boolean(h)
  };
  const stamp = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  const check = new Date(stamp);
  if (
    check.getUTCFullYear() !== parts.year ||
    check.getUTCMonth() !== parts.month - 1 ||
    check.getUTCDate() !== parts.day ||
    check.getUTCHours() !== parts.hour ||
    check.getUTCMinutes() !== parts.minute
  ) {
    return null;
  }
  return parts;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatTemporal(value, hint) {
  const parts = parseTemporal(value);
  if (!parts) throw new Error(`Invalid date value '${value}': expected ISO 8601`);
  return hint.replace(DATE_TOKEN_RE, (token) => {
    switch (token) {
      case 'yyyy': return String(parts.year).padStart(4, '0');
      case 'yy': return pad2(parts.year % 100);
      case 'MM': return pad2(parts.month);
      case 'M': return String(parts.month);
      case 'dd': return pad2(parts.day);
      case 'd': return String(parts.day);
      case 'HH': return pad2(parts.hour);
      case 'H': return String(parts.hour);
      case 'mm': return pad2(parts.minute);
      case 'ss': return pad2(parts.second);
      default: return token;
    }
  });
}

const DEFAULT_HINTS = {
  money: '#,##0.00',
  number: '0.###',
  date: 'yyyy-MM-dd',
  datetime: 'yyyy-MM-dd HH:mm'
};

function isNumericType(dataType) {
  return dataType === 'money' || dataType === 'number';
}

function isTemporalType(dataType) {
  return dataType === 'date' || dataType === 'datetime';
}

/** Throws on an invalid hint; used at schema registration (SCHEMA_INVALID). */
function assertHint(dataType, hint) {
  if (hint === null || hint === undefined) return;
  if (typeof hint !== 'string' || hint.length === 0) {
    throw new Error(`formatHint for '${dataType}' must be a non-empty string`);
  }
  if (isNumericType(dataType)) {
    parseNumericPattern(hint);
    if (!/[#0]/.test(hint)) throw new Error(`formatHint '${hint}' has no digit pattern`);
  } else if (isTemporalType(dataType)) {
    if (!DATE_TOKEN_RE.test(hint)) throw new Error(`formatHint '${hint}' has no date tokens`);
    DATE_TOKEN_RE.lastIndex = 0;
  } else if (hint !== null) {
    throw new Error(`formatHint is not applicable to dataType '${dataType}'`);
  }
}

/** Formats a bound scalar according to its schema type. */
function formatScalar(dataType, value, hint) {
  if (value === null || value === undefined) return null;
  if (dataType === 'money' || dataType === 'number') {
    return formatNumber(value, hint || DEFAULT_HINTS[dataType]);
  }
  if (isTemporalType(dataType)) {
    return formatTemporal(value, hint || DEFAULT_HINTS[dataType]);
  }
  return value;
}

/** SPEC §3.8: money/number inputs are numeric, never pre-formatted. */
function coerceNumericInput(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return undefined;
}

module.exports = {
  parseNumericPattern,
  formatNumber,
  formatTemporal,
  formatScalar,
  assertHint,
  coerceNumericInput,
  DEFAULT_HINTS,
  isNumericType,
  isTemporalType
};
