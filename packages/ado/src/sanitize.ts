import { normalizeHtml } from './html.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
const forbiddenKey = /email|identity|guid|descriptor|avatar|personid|auth|token|secret|password|cookie|assignedto|createdby|changedby|revisedby|uniqueName|displayName|imageurl|^_links$|watermark|relationcount/i;

export function sanitizeText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s<>()]+/gi, address => {
      try {
        const url = new URL(address);
        if (url.username || url.password || /avatar|identity|personid|descriptor|profilephoto/i.test(url.pathname)) return '[redacted-url]';
        url.search = '';
        url.hash = '';
        return url.href;
      } catch { return '[redacted-url]'; }
    })
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted-identity]')
    .replace(/\b(?:aad|msa|svc|vss|acs)\.[A-Za-z0-9_+/=-]+/gi, '[redacted-descriptor]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[redacted-auth]')
    .replace(/\b(?:authorization|(?:access|refresh|auth)?token|secret|password|cookie|person[_. -]?id|descriptor|avatar|authmetadata)\b["']?\s*(?:[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '[redacted-metadata]');
}

export function sanitizeValue(value: JsonValue, depth = 0): JsonValue {
  if (depth > 32) throw new Error('Custom field nesting exceeds limit');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Expected finite custom number');
  if (typeof value === 'string') return sanitizeText(normalizeHtml(value).text);
  if (Array.isArray(value)) return value.map(entry => sanitizeValue(entry, depth + 1));
  if (value !== null && typeof value === 'object') {
    if (Object.keys(value).some(key => /descriptor|personid|uniqueName|avatar|imageurl/i.test(key))) return '[quarantined-identity]';
    return Object.fromEntries(Object.entries(value).filter(([key]) => !forbiddenKey.test(key)).map(([key, entry]) => [sanitizeText(key), sanitizeValue(entry, depth + 1)]));
  }
  return value;
}

export function safeCustomKey(key: string): boolean {
  return /^[a-z][a-zA-Z0-9_]{0,63}$/.test(key) && !forbiddenKey.test(key) && !['constructor', 'prototype', '__proto__'].includes(key);
}
