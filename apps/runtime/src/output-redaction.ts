const DEFAULT_TAIL = 4096;

export function redactOutput(value: string, explicitValues: readonly string[] = []): string {
  let output = value;
  for (const secret of explicitValues) {
    if (secret.length === 0) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  output = output
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(API[_-]?TOKEN|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|CREDENTIAL)\s*=\s*([^\s\r\n]+)/gi, '$1=[REDACTED]')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*['"]?([^\s,'"}\]]+)/gi, '$1=[REDACTED]');
  return output;
}

export class StreamingRedactor {
  private tail = '';
  private readonly keep: number;

  public constructor(private readonly explicitValues: readonly string[] = []) {
    const longest = explicitValues.reduce((max, value) => Math.max(max, value.length), 0);
    this.keep = Math.max(DEFAULT_TAIL, longest + 256);
  }

  public push(chunk: string): string {
    const combined = this.tail + chunk;
    if (combined.length <= this.keep) {
      this.tail = combined;
      return '';
    }
    const splitAt = combined.length - this.keep;
    const flush = combined.slice(0, splitAt);
    this.tail = combined.slice(splitAt);
    return redactOutput(flush, this.explicitValues);
  }

  public finish(): string {
    const value = redactOutput(this.tail, this.explicitValues);
    this.tail = '';
    return value;
  }
}

export function boundedTail(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  return { text: buffer.subarray(buffer.byteLength - maxBytes).toString('utf8'), truncated: true };
}
