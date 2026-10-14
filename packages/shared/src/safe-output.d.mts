export declare const REDACTION_MARKER: string;
export declare const REDACTION_LIMITS: Readonly<Record<string, number>>;
export declare function redactStructuredValue(value: unknown, explicitValues?: readonly string[]): unknown;
export declare function redactOutput(value: string, explicitValues?: readonly string[]): string;
export declare function safeErrorMessage(error: unknown, fallback?: string): string;
export declare function safePublicError(code: string, errorOrMessage?: unknown): { readonly code: string; readonly message: string };
export declare function safeSerialize(value: unknown, explicitValues?: readonly string[]): string;
export declare class StreamingRedactor {
  constructor(explicitValues?: readonly string[]);
  readonly wasQuarantined: boolean;
  push(chunk: string | Uint8Array): string;
  finish(): string;
}
export declare function boundedTail(value: string, maxBytes: number): { readonly text: string; readonly truncated: boolean };
