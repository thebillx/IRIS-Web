const DEFAULT_TAIL = 4096;
const SENSITIVE_KEY = String.raw`(?:authorization|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|token|owner[_-]?access[_-]?secret)`;
const SENSITIVE_PREFIX = new RegExp(String.raw`(?:\\?["']?${SENSITIVE_KEY}\\?["']?)\s*[:=]\s*`, 'gi');
const BEARER_ASSIGNMENT = new RegExp(String.raw`((?:\\?["']?${SENSITIVE_KEY}\\?["']?)\s*[:=]\s*)Bearer\s+[^\s\r\n,}\]]+`, 'gi');

export function redactOutput(value: string, explicitValues: readonly string[] = []): string {
  let output = value;
  for (const secret of explicitValues) {
    if (secret.length === 0) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  output = output
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(API[_-]?TOKEN|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|CREDENTIAL)\s*=\s*([^\s\r\n]+)/gi, '$1=[REDACTED]')
    .replace(BEARER_ASSIGNMENT, '$1Bearer [REDACTED]');
  return redactStructuredAssignments(output);
}

function redactStructuredAssignments(value: string): string {
  let output = '';
  let cursor = 0;
  SENSITIVE_PREFIX.lastIndex = 0;
  for (const match of value.matchAll(SENSITIVE_PREFIX)) {
    const start = match.index ?? 0;
    if (start < cursor) continue;
    const valueStart = start + match[0].length;
    output += value.slice(cursor, valueStart);
    const bearer = /^Bearer\s+/i.exec(value.slice(valueStart));
    const valueEnd = bearer === null ? consumeSensitiveValue(value, valueStart) : consumeBearerValue(value, valueStart + bearer[0].length);
    output += bearer === null ? '[REDACTED]' : 'Bearer [REDACTED]';
    cursor = valueEnd;
  }
  return output + value.slice(cursor);
}

function consumeBearerValue(value: string, start: number): number {
  if (value[start] === '[') return consumeBalancedValue(value, start);
  let end = start;
  while (end < value.length && !/[\s,}\]]/.test(value[end] ?? '')) end += 1;
  return end > start ? end : Math.min(value.length, start + 1);
}

function consumeSensitiveValue(value: string, start: number): number {
  const first = value[start];
  if (first === '"' || first === "'") return consumeQuotedValue(value, start, first);
  if (first === '[' || first === '{') return consumeBalancedValue(value, start);
  let end = start;
  while (end < value.length && !/[\s,}\]]/.test(value[end] ?? '')) end += 1;
  return end > start ? end : Math.min(value.length, start + 1);
}

function consumeQuotedValue(value: string, start: number, quote: string): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) { escaped = false; continue; }
    if (character === '\\') { escaped = true; continue; }
    if (character === quote) return index + 1;
  }
  return value.length;
}

function consumeBalancedValue(value: string, start: number): number {
  const stack = [value[start] === '[' ? ']' : '}'];
  let quote: string | undefined;
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (quote !== undefined) {
      if (escaped) { escaped = false; continue; }
      if (character === '\\') { escaped = true; continue; }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '[') { stack.push(']'); continue; }
    if (character === '{') { stack.push('}'); continue; }
    if (character === ']' || character === '}') {
      if (stack.at(-1) !== character) return value.length;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }
  return value.length;
}

export class StreamingRedactor {
  private tail = '';
  private readonly keep: number;

  public constructor(private readonly explicitValues: readonly string[] = []) {
    const longest = explicitValues.reduce((max, value) => Math.max(max, value.length), 0);
    this.keep = Math.max(DEFAULT_TAIL, longest + 512);
  }

  public push(chunk: string): string {
    const combined = this.tail + chunk;
    if (combined.length <= this.keep) {
      this.tail = combined;
      return '';
    }
    const splitAt = combined.length - this.keep;
    const overlap = Math.max(256, this.explicitValues.reduce((max, value) => Math.max(max, value.length), 0));
    const safeEnd = safeStreamingEnd(combined, Math.max(0, splitAt - overlap));
    if (safeEnd === 0) {
      this.tail = combined;
      return '';
    }
    const flush = combined.slice(0, safeEnd);
    this.tail = combined.slice(safeEnd);
    return redactOutput(flush, this.explicitValues);
  }

  public finish(): string {
    const value = redactOutput(this.tail, this.explicitValues);
    this.tail = '';
    return value;
  }
}

function safeStreamingEnd(value: string, proposedEnd: number): number {
  let safeEnd = proposedEnd;
  SENSITIVE_PREFIX.lastIndex = 0;
  for (const match of value.matchAll(SENSITIVE_PREFIX)) {
    const start = match.index ?? 0;
    if (start >= safeEnd) break;
    const lineEnd = value.indexOf('\n', start);
    if (lineEnd < 0 || lineEnd >= safeEnd) safeEnd = start;
  }
  return safeEnd;
}

export function boundedTail(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: buffer.subarray(buffer.byteLength - maxBytes).toString('utf8'), truncated: true };
}
