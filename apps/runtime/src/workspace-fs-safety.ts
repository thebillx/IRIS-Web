import { spawn } from 'node:child_process';
import path from 'node:path';
import { RuntimeError } from '@iris/domain';

const PYTHON = '/usr/bin/python3';
const HELPER = path.resolve(import.meta.dirname, '..', 'vnext-fs-helper.py');
const MAX_HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 30_000;

export interface SecureHashResult {
  readonly sha256: string;
  readonly size: number;
}

export interface SecureTextReadResult {
  readonly text: string;
  readonly bytes: number;
  readonly encoding: 'utf-8';
}

export interface SecureRangeReadResult {
  readonly base64: string;
  readonly offset: number;
  readonly bytes: number;
  readonly fileSize: number;
  readonly eof: boolean;
}

export interface SecureCreateReplaceResult {
  readonly bytes: number;
  readonly mode: 'CREATE' | 'REPLACE';
}

export interface SecureAppendResult {
  readonly bytesAppended: number;
  readonly sizeBefore: number;
  readonly sizeAfter: number;
  readonly mode: 'APPEND';
}

export async function secureWorkspaceHash(workspaceRoot: string, targetPath: string): Promise<SecureHashResult> {
  return parseHash(await runJsonHelper(['hash-file', workspaceRoot, targetPath]));
}

export async function secureWorkspaceReadText(
  workspaceRoot: string,
  targetPath: string,
  maxBytes: number,
  encoding: 'utf-8' = 'utf-8',
): Promise<SecureTextReadResult> {
  return parseText(await runJsonHelper(['read-text', workspaceRoot, targetPath, String(maxBytes), encoding]));
}

export async function secureWorkspaceReadRange(
  workspaceRoot: string,
  targetPath: string,
  offset: number,
  length: number,
): Promise<SecureRangeReadResult> {
  return parseRange(await runJsonHelper(['read-range', workspaceRoot, targetPath, String(offset), String(length)]));
}

export async function secureWorkspaceCreate(
  workspaceRoot: string,
  targetPath: string,
  payload: Buffer,
): Promise<SecureCreateReplaceResult> {
  return parseCreateReplace(await runJsonHelper(['write-create', workspaceRoot, targetPath], payload), 'CREATE');
}

export async function secureWorkspaceReplace(
  workspaceRoot: string,
  targetPath: string,
  payload: Buffer,
): Promise<SecureCreateReplaceResult> {
  return parseCreateReplace(await runJsonHelper(['write-replace', workspaceRoot, targetPath], payload), 'REPLACE');
}

export async function secureWorkspaceAppend(
  workspaceRoot: string,
  targetPath: string,
  payload: Buffer,
  expectedSize: number,
  expectedSha256?: string,
): Promise<SecureAppendResult> {
  try {
    return parseAppend(await runJsonHelper([
      'append-file', workspaceRoot, targetPath, String(expectedSize), expectedSha256 ?? '-',
    ], payload));
  } catch (error) {
    if (error instanceof RuntimeError && /precondition/i.test(error.message)) {
      throw new RuntimeError('PRECONDITION_FAILED', error.message, { cause: error });
    }
    throw error;
  }
}

async function runJsonHelper(args: readonly string[], input?: Buffer): Promise<unknown> {
  try {
    const stdout = await runHelper(args, input);
    return JSON.parse(stdout) as unknown;
  } catch (error) {
    if (error instanceof RuntimeError) throw error;
    const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(-800) : 'unknown helper failure';
    throw new RuntimeError('CAPABILITY_DENIED', `Phase 2 filesystem safety helper refused the operation${detail.length > 0 ? `: ${detail}` : ''}`, { cause: error });
  }
}

function runHelper(args: readonly string[], input?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON, ['-I', '-S', HELPER, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolve(Buffer.concat(stdout).toString('utf8'));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Phase 2 filesystem safety helper timed out'));
    }, HELPER_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('Phase 2 filesystem helper stdout exceeded the bounded result size'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new Error(`Phase 2 filesystem helper failed (${code ?? 'signal'}): ${Buffer.concat(stderr).toString('utf8').trim()}`));
        return;
      }
      finish();
    });
    child.stdin.on('error', (error) => finish(error));
    child.stdin.end(input ?? Buffer.alloc(0));
  });
}

function parseHash(value: unknown): SecureHashResult {
  const record = requireRecord(value);
  if (typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256) || !safeNonNegativeInteger(record.size)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 hash helper returned an invalid result');
  }
  return { sha256: record.sha256, size: record.size };
}

function parseText(value: unknown): SecureTextReadResult {
  const record = requireRecord(value);
  if (typeof record.text !== 'string' || !safeNonNegativeInteger(record.bytes) || record.encoding !== 'utf-8') {
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 text-read helper returned an invalid result');
  }
  return { text: record.text, bytes: record.bytes, encoding: 'utf-8' };
}

function parseRange(value: unknown): SecureRangeReadResult {
  const record = requireRecord(value);
  if (typeof record.base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(record.base64)
    || !safeNonNegativeInteger(record.offset) || !safeNonNegativeInteger(record.bytes)
    || !safeNonNegativeInteger(record.fileSize) || typeof record.eof !== 'boolean') {
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 range-read helper returned an invalid result');
  }
  return { base64: record.base64, offset: record.offset, bytes: record.bytes, fileSize: record.fileSize, eof: record.eof };
}

function parseCreateReplace(value: unknown, mode: 'CREATE' | 'REPLACE'): SecureCreateReplaceResult {
  const record = requireRecord(value);
  if (!safeNonNegativeInteger(record.bytes) || record.mode !== mode) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 write helper returned an invalid result');
  }
  return { bytes: record.bytes, mode };
}

function parseAppend(value: unknown): SecureAppendResult {
  const record = requireRecord(value);
  if (!safeNonNegativeInteger(record.bytesAppended) || !safeNonNegativeInteger(record.sizeBefore)
    || !safeNonNegativeInteger(record.sizeAfter) || record.mode !== 'APPEND'
    || record.sizeAfter !== record.sizeBefore + record.bytesAppended) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 append helper returned an invalid result');
  }
  return {
    bytesAppended: record.bytesAppended,
    sizeBefore: record.sizeBefore,
    sizeAfter: record.sizeAfter,
    mode: 'APPEND',
  };
}

function safeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RuntimeError('CAPABILITY_DENIED', 'Phase 2 filesystem helper returned a non-object result');
  }
  return value as Record<string, unknown>;
}
