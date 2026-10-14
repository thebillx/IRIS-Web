/* global Buffer, TextDecoder */

const REDACTED = '[REDACTED_UNCERTAIN]';
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_STREAM_BYTES = 256 * 1024;
const MAX_NODES = 4096;
const MAX_DEPTH = 32;
const MAX_WRAPPERS = 3;
const SENSITIVE_KEYS = new Set([
  'authorization', 'apikey', 'authtoken', 'accesstoken', 'refreshtoken',
  'password', 'passwd', 'secret', 'credential', 'token', 'owneraccesstoken', 'owneraccesssecret',
]);
const SENSITIVE_KEY_TEXT = /(?:^|["'{,\s]|\\?")[a-z0-9_-]*(?:authorization|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|token|owner[_-]?access[_-]?(?:token|secret))(?=["'\s:},=]|\\?")/i;
const SENSITIVE_ASSIGNMENT = /\b[a-z0-9_-]*(?:authorization|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|private[_-]?key|token)\s*[:=]/i;
const PRIVATE_KEY_BEGIN = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const PRIVATE_KEY_END = /-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/;
const PUBLIC_MESSAGES = new Map([
  ['CONTROL_DENIED', 'Access denied'],
  ['CAPABILITY_DENIED', 'Capability denied'],
  ['INVALID_REQUEST', 'Invalid request'],
  ['PERSISTENCE_FAILURE', 'Persistence operation failed'],
  ['AGENT_EXECUTION_FAILED', 'Agent execution failed'],
  ['PROCESS_OWNERSHIP_AMBIGUOUS', 'Process ownership could not be verified'],
]);

export const REDACTION_MARKER = REDACTED;
export const REDACTION_LIMITS = Object.freeze({ MAX_INPUT_BYTES, MAX_STREAM_BYTES, MAX_NODES, MAX_DEPTH, MAX_WRAPPERS });

function bytes(value) { return Buffer.byteLength(value, 'utf8'); }
function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function explicitMatch(value, explicitValues) { return explicitValues.some((secret) => typeof secret === 'string' && secret.length > 0 && value.includes(secret)); }

function inspectionText(value) {
  return value.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(Number.parseInt(code, 16))).normalize('NFKC');
}

function compactSensitiveText(value) {
  return inspectionText(value).replace(/[\s\p{Cf}\p{Mn}\u00ad]/gu, '');
}

function isSensitiveKey(key) {
  const normalized = key.normalize('NFKC').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEYS.has(normalized)
    || /(?:authorization|apikey|authtoken|accesstoken|refreshtoken|password|passwd|secret|credential|credentials|privatekey|token)$/.test(normalized);
}

function hasStructuredMarker(value, explicitValues) {
  const inspected = compactSensitiveText(value);
  return (SENSITIVE_KEY_TEXT.test(inspected) || explicitMatch(value, explicitValues))
    && (value.includes('{') || value.includes('[') || value.includes('"') || value.includes('\\"'));
}

function looksStructuredCandidate(value) {
  return /[{}[\]\\"]/.test(value);
}

function hasSensitiveAssignment(value) {
  return SENSITIVE_ASSIGNMENT.test(compactSensitiveText(value));
}

function redactPlain(value, explicitValues) {
  let output = value;
  for (const secret of explicitValues) {
    if (typeof secret === 'string' && secret.length > 0) output = output.split(secret).join('[REDACTED]');
  }
  if (PRIVATE_KEY_BEGIN.test(output)) return REDACTED;
  output = output.split('\n').map((line) => {
    const compact = compactSensitiveText(line);
    return SENSITIVE_ASSIGNMENT.test(compact) && !SENSITIVE_ASSIGNMENT.test(line) ? REDACTED : line;
  }).join('\n');
  return output
    .replace(/(\bAUTHORIZATION\s*[:=]\s*)([A-Za-z]+\s+)?[^\r\n]*?(?=\s+[A-Z][A-Z0-9_-]*\s*[:=]|\s*$)/gi, (_, prefix, scheme = '') => `${prefix}${scheme}[REDACTED]`)
    .replace(/(\b[A-Z0-9_-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY|API[_-]?KEY)\s*[:=]\s*)[^\r\n]*?(?=\s+[A-Z][A-Z0-9_-]*\s*[:=]|\s*$)/gi, '$1[REDACTED]');
}

function redactStructuredValueInternal(value, explicitValues, depth, budget) {
  if (depth > MAX_DEPTH || budget.nodes >= MAX_NODES) return REDACTED;
  budget.nodes += 1;
  if (Array.isArray(value)) return value.map((item) => redactStructuredValueInternal(item, explicitValues, depth + 1, budget));
  if (isRecord(value)) {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key) || explicitMatch(key, explicitValues)) continue;
      output[key] = redactStructuredValueInternal(item, explicitValues, depth + 1, budget);
    }
    return output;
  }
  if (typeof value !== 'string') return value;
  const sanitized = redactPlain(value, explicitValues);
  if (looksStructuredCandidate(sanitized)) {
    const serialized = redactSerializedText(sanitized, explicitValues, 0, budget);
    if (serialized !== null) return serialized.changed ? JSON.stringify(serialized.value) : sanitized;
    return REDACTED;
  }
  return hasStructuredMarker(sanitized, explicitValues) ? REDACTED : sanitized;
}

function redactSerializedText(value, explicitValues, depth, budget) {
  if (depth > MAX_WRAPPERS || bytes(value) > MAX_INPUT_BYTES) return null;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return null; }
  if (typeof parsed === 'string' && looksStructuredCandidate(parsed)) {
    const nested = redactSerializedText(parsed, explicitValues, depth + 1, budget);
    if (nested === null) return null;
    return { value: JSON.stringify(nested.value), changed: nested.changed };
  }
  const redacted = redactStructuredValueInternal(parsed, explicitValues, depth + 1, budget);
  return { value: redacted, changed: JSON.stringify(redacted) !== JSON.stringify(parsed) };
}

export function redactStructuredValue(value, explicitValues = []) {
  return redactStructuredValueInternal(value, explicitValues, 0, { nodes: 0 });
}

export function redactOutput(value, explicitValues = []) {
  if (typeof value !== 'string') return REDACTED;
  if (bytes(value) > MAX_INPUT_BYTES) return REDACTED;
  if (PRIVATE_KEY_BEGIN.test(value)) return REDACTED;
  if (hasStructuredMarker(value, explicitValues)) return REDACTED;
  if (looksStructuredCandidate(value)) {
    const serialized = redactSerializedText(value, explicitValues, 0, { nodes: 0 });
    if (serialized !== null) return serialized.changed ? JSON.stringify(serialized.value) : value;
    return REDACTED;
  }
  return redactPlain(value, explicitValues);
}

export function safeErrorMessage(error, fallback = 'Operation failed') {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.replace(/[\r\n\0]/g, ' ').slice(0, 500);
  return hasStructuredMarker(message, []) ? fallback : redactPlain(message, []);
}

export function safePublicError(code, errorOrMessage = undefined) {
  const message = typeof errorOrMessage === 'string' ? errorOrMessage : safeErrorMessage(errorOrMessage, 'Operation failed');
  const sanitized = redactPlain(message, []);
  return Object.freeze({ code, message: hasStructuredMarker(sanitized, []) ? (PUBLIC_MESSAGES.get(code) ?? 'Operation failed') : sanitized });
}

export function safeSerialize(value, explicitValues = []) {
  try {
    const encoded = JSON.stringify(redactStructuredValue(value, explicitValues));
    return bytes(encoded) > MAX_INPUT_BYTES ? JSON.stringify(REDACTED) : encoded;
  }
  catch { return JSON.stringify(REDACTED); }
}

export class StreamingRedactor {
  #decoder = new TextDecoder('utf-8', { fatal: true });
  #pending = '';
  #quarantined = false;
  #markerPending = false;
  #recordQuarantine = false;
  #privateKeyQuarantine = false;
  #explicit;
  constructor(explicitValues = []) { this.#explicit = explicitValues; }

  get wasQuarantined() { return this.#quarantined || this.#recordQuarantine; }

  push(chunk) {
    if (this.#quarantined) return '';
    let decoded;
    try { decoded = this.#decode(chunk); } catch { this.#quarantined = true; this.#markerPending = true; return REDACTED; }
    this.#pending += decoded;
    if (looksStructuredCandidate(this.#pending) || hasStructuredMarker(this.#pending, this.#explicit)) {
      if (bytes(this.#pending) > MAX_STREAM_BYTES) {
        this.#pending = '';
        this.#quarantined = true;
        this.#markerPending = false;
        return REDACTED;
      }
      return '';
    }
    let output = '';
    let newline;
    while ((newline = this.#pending.indexOf('\n')) >= 0) {
      const line = this.#pending.slice(0, newline + 1);
      this.#pending = this.#pending.slice(newline + 1);
      if (this.#recordQuarantine) {
        if (this.#privateKeyQuarantine) {
          if (PRIVATE_KEY_END.test(line)) {
            this.#recordQuarantine = false;
            this.#privateKeyQuarantine = false;
          }
        }
        continue;
      }
      output += redactOutput(line, this.#explicit);
      if (hasSensitiveAssignment(line) || PRIVATE_KEY_BEGIN.test(line)) {
        this.#recordQuarantine = true;
        this.#privateKeyQuarantine = PRIVATE_KEY_BEGIN.test(line);
      }
    }
    if (bytes(this.#pending) > MAX_STREAM_BYTES) {
      output += REDACTED;
      this.#pending = '';
      this.#quarantined = true;
      this.#markerPending = false;
    }
    return output;
  }

  finish() {
    let decoded = '';
    try { decoded = this.#decoder.decode(); } catch { this.#quarantined = true; }
    if (this.#quarantined) return this.#markerPending ? REDACTED : '';
    this.#pending += decoded;
    const output = this.#pending.length === 0 || this.#recordQuarantine ? '' : finishPending(this.#pending, this.#explicit);
    this.#pending = '';
    return output;
  }

  #decode(chunk) {
    if (typeof chunk === 'string') return chunk;
    if (chunk instanceof Uint8Array) return this.#decoder.decode(chunk, { stream: true });
    throw new TypeError('stream chunk must be text or bytes');
  }

}

function finishPending(value, explicitValues) {
  const output = redactOutput(value, explicitValues);
  if (!looksStructuredCandidate(value) || output !== value) return output;
  try {
    return safeSerialize(JSON.parse(value), explicitValues);
  } catch {
    return REDACTED;
  }
}

export function boundedTail(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: buffer.subarray(buffer.byteLength - maxBytes).toString('utf8'), truncated: true };
}
