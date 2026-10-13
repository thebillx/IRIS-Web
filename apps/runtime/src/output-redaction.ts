const DEFAULT_TAIL = 4096;
const SENSITIVE_KEY = String.raw`(?:authorization|api[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|secret|credential|token|owner[_-]?access[_-]?secret)`;
const QUOTED_VALUE = String.raw`\\?"(?:\\.|[^"\\])*\\?"|\\?'(?:\\.|[^'\\])*\\?'`;
const UNQUOTED_VALUE = String.raw`[^,\s}\]]+`;
const SENSITIVE_ASSIGNMENT = new RegExp(String.raw`((?:\\?["']?${SENSITIVE_KEY}\\?["']?)\s*[:=]\s*)(?!(?:Bearer)\s+)(${QUOTED_VALUE}|${UNQUOTED_VALUE})`, 'gi');
const BEARER_ASSIGNMENT = new RegExp(String.raw`((?:\\?["']?${SENSITIVE_KEY}\\?["']?)\s*[:=]\s*)Bearer\s+([^\s\r\n,}\]]+)`, 'gi');
const SENSITIVE_PREFIX = new RegExp(String.raw`(?:\\?["']?${SENSITIVE_KEY}\\?["']?)\s*[:=]\s*`, 'gi');

export function redactOutput(value: string, explicitValues: readonly string[] = []): string {
  let output = value;
  for (const secret of explicitValues) {
    if (secret.length === 0) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  output = output
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(API[_-]?TOKEN|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|CREDENTIAL)\s*=\s*([^\s\r\n]+)/gi, '$1=[REDACTED]')
    .replace(BEARER_ASSIGNMENT, '$1Bearer [REDACTED]')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]');
  return output;
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
