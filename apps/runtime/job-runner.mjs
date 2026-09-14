/* global URL, process, setTimeout, setInterval, clearTimeout, clearInterval */
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HELPER = new URL('./macos-safety-helper.py', import.meta.url).pathname;
const args = process.argv.slice(2);
const specPath = option('--spec');
const expectedJobId = option('--job');
const expectedRunner = option('--runner');

let spec;
let timeout;
let cancelPoll;
let child;
let pgid;
let cancelled = false;
let timedOut = false;
let resultPublished = false;

async function main() {
  const runnerPid = process.pid;
  const runnerStartMarker = processStartMarker(runnerPid);
  const runnerProcessGroupId = processGroupId(runnerPid);
  if (runnerProcessGroupId !== runnerPid) throw new Error('durable runner does not own its process group');

  await publishAtomic(spec.runnerClaimPath, {
    schemaVersion: 1,
    jobId: spec.jobId,
    runnerIdentity: spec.runnerIdentity,
    runnerPid,
    runnerProcessGroupId,
    runnerStartMarker,
    createdAt: new Date().toISOString(),
  });
  await waitForPermit();

  const stdoutStream = createWriteStream(spec.stdoutPath, { flags: 'a' });
  const stderrStream = createWriteStream(spec.stderrPath, { flags: 'a' });
  const stdoutRedactor = new StreamingRedactor(spec.redactionValues);
  const stderrRedactor = new StreamingRedactor(spec.redactionValues);
  child = spawn(spec.executableIdentity, spec.argv, {
    cwd: spec.cwd,
    env: spec.environment,
    detached: true,
    stdio: [spec.stdinPath ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (child.pid === undefined) throw new Error('target process did not expose a PID');
  const targetPid = child.pid;
  const targetStartMarker = processStartMarker(targetPid);
  pgid = processGroupId(targetPid);
  if (spec.stdinPath && child.stdin) createReadStream(spec.stdinPath).pipe(child.stdin);

  await publishAtomic(spec.claimPath, {
    schemaVersion: 1,
    jobId: spec.jobId,
    runnerIdentity: spec.runnerIdentity,
    runnerPid,
    runnerProcessGroupId,
    runnerStartMarker,
    targetPid,
    targetProcessGroupId: pgid,
    targetStartMarker,
    createdAt: new Date().toISOString(),
  });

  child.stdout?.on('data', (chunk) => {
    const text = stdoutRedactor.push(String(chunk));
    if (text) writeWithBackpressure(stdoutStream, text, child.stdout);
  });
  child.stderr?.on('data', (chunk) => {
    const text = stderrRedactor.push(String(chunk));
    if (text) writeWithBackpressure(stderrStream, text, child.stderr);
  });

  timeout = setTimeout(() => {
    timedOut = true;
    safeKillGroup(pgid, 'SIGTERM');
    setTimeout(() => safeKillGroup(pgid, 'SIGKILL'), 1000).unref();
  }, spec.timeoutMs);
  timeout.unref();
  cancelPoll = setInterval(async () => {
    try {
      await access(spec.cancelPath);
      cancelled = true;
      safeKillGroup(pgid, 'SIGTERM');
      setTimeout(() => safeKillGroup(pgid, 'SIGKILL'), 1000).unref();
      clearInterval(cancelPoll);
    } catch {
      // No cancel request is present yet.
    }
  }, 100);
  cancelPoll.unref();

  const terminal = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  clearInterval(cancelPoll);
  clearTimeout(timeout);
  const out = stdoutRedactor.finish();
  const err = stderrRedactor.finish();
  if (out) stdoutStream.write(out);
  if (err) stderrStream.write(err);
  await Promise.all([endStream(stdoutStream), endStream(stderrStream)]);
  const state = cancelled || timedOut ? 'CANCELLED' : terminal.code === 0 ? 'SUCCEEDED' : 'FAILED';
  await publishAtomic(spec.resultPath, {
    schemaVersion: 1,
    jobId: spec.jobId,
    runnerIdentity: spec.runnerIdentity,
    state,
    exitCode: terminal.code,
    signal: terminal.signal,
    timedOut,
    cancelled,
    error: null,
    finishedAt: new Date().toISOString(),
  });
  resultPublished = true;
}

async function waitForPermit() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const permit = JSON.parse(await readFile(spec.permitPath, 'utf8'));
      if (permit?.jobId !== spec.jobId || permit?.runnerIdentity !== spec.runnerIdentity) throw new Error('start permit identity mismatch');
      return;
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      if (error instanceof SyntaxError) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      throw error;
    }
  }
  throw new Error('start permit was not published before timeout');
}

async function publishFailure(error) {
  if (resultPublished || !spec || typeof spec.resultPath !== 'string') return;
  try {
    await publishAtomic(spec.resultPath, {
      schemaVersion: 1,
      jobId: spec.jobId ?? expectedJobId,
      runnerIdentity: spec.runnerIdentity ?? expectedRunner,
      state: 'FAILED',
      exitCode: null,
      signal: null,
      timedOut,
      cancelled,
      error: error instanceof Error ? error.message.slice(0, 500) : 'runner failure',
      finishedAt: new Date().toISOString(),
    });
    resultPublished = true;
  } catch {
    // Bootstrap diagnostics are best-effort only; target spawn remains fail-closed.
  }
  if (child?.pid && pgid) {
    safeKillGroup(pgid, 'SIGTERM');
    try {
      process.kill(child.pid, 0);
      safeKillGroup(pgid, 'SIGKILL');
    } catch {
      // Target process is already gone.
    }
  }
}

function validateSpec(value, jobId, runnerIdentity) {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.jobId !== jobId || value.runnerIdentity !== runnerIdentity) throw new Error('runner spec identity mismatch');
  for (const key of ['executableIdentity','cwd','stdoutPath','stderrPath','runnerClaimPath','permitPath','claimPath','resultPath','cancelPath']) if (typeof value[key] !== 'string' || !path.isAbsolute(value[key])) throw new Error(`runner spec ${key} is invalid`);
  if (!Array.isArray(value.argv) || !value.argv.every((item) => typeof item === 'string')) throw new Error('runner argv is invalid');
  if (!isRecord(value.environment) || !Object.values(value.environment).every((item) => typeof item === 'string')) throw new Error('runner environment is invalid');
  if (!Array.isArray(value.redactionValues) || !value.redactionValues.every((item) => typeof item === 'string')) throw new Error('runner redaction values are invalid');
  if (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1 || value.timeoutMs > 3600000) throw new Error('runner timeout is invalid');
  if (value.stdinPath !== null && (typeof value.stdinPath !== 'string' || !path.isAbsolute(value.stdinPath))) throw new Error('runner stdin path is invalid');
}

function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || typeof args[index + 1] !== 'string' || args[index + 1].length === 0) throw new Error(`${name} is required`);
  return args[index + 1];
}

function processStartMarker(pid) {
  const marker = execFileSync('/usr/bin/python3', ['-I', '-S', HELPER, 'process-start', String(pid)], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024, env: { PATH: '/usr/bin:/bin' },
  }).trim();
  if (!/^\d+:\d{6}$/.test(marker)) throw new Error('process start marker is invalid');
  return marker;
}

function processGroupId(pid) {
  const value = execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, maxBuffer: 16 * 1024 }).trim();
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 1) throw new Error('process group id is invalid');
  return id;
}

async function publishAtomic(filename, value) {
  const temp = `${filename}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temp, filename);
  await rm(temp, { force: true }).catch(() => undefined);
}

function safeKillGroup(id, signal) {
  if (!Number.isSafeInteger(id) || id <= 1) return;
  try { process.kill(-id, signal); } catch { /* Verified group may already be gone. */ }
}

function writeWithBackpressure(stream, text, source) {
  if (!stream.write(text) && source) {
    source.pause();
    stream.once('drain', () => source.resume());
  }
}

function endStream(stream) {
  return new Promise((resolve) => stream.end(resolve));
}

function redactOutput(value, explicitValues) {
  let output = value;
  for (const secret of explicitValues) {
    if (secret.length === 0) continue;
    output = output.split(secret).join('[REDACTED]');
  }
  return output
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s\r\n]+/gi, '$1[REDACTED]')
    .replace(/\b(API[_-]?TOKEN|AUTH[_-]?TOKEN|ACCESS[_-]?TOKEN|REFRESH[_-]?TOKEN|PASSWORD|PASSWD|SECRET|API[_-]?KEY|CREDENTIAL)\s*=\s*([^\s\r\n]+)/gi, '$1=[REDACTED]')
    .replace(/\b(password|token|secret|api[_-]?key)\s*[:=]\s*['"]?([^\s,'"}\]]+)/gi, '$1=[REDACTED]');
}

class StreamingRedactor {
  #tail = '';
  #keep;
  #explicit;
  constructor(explicitValues) {
    this.#explicit = explicitValues;
    const longest = explicitValues.reduce((max, value) => Math.max(max, value.length), 0);
    this.#keep = Math.max(4096, longest + 256);
  }
  push(chunk) {
    const combined = this.#tail + chunk;
    if (combined.length <= this.#keep) { this.#tail = combined; return ''; }
    const splitAt = combined.length - this.#keep;
    const flush = combined.slice(0, splitAt);
    this.#tail = combined.slice(splitAt);
    return redactOutput(flush, this.#explicit);
  }
  finish() {
    const value = redactOutput(this.#tail, this.#explicit);
    this.#tail = '';
    return value;
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

try {
  spec = JSON.parse(await readFile(specPath, 'utf8'));
  validateSpec(spec, expectedJobId, expectedRunner);
  await main();
} catch (error) {
  await publishFailure(error);
  process.exitCode = 1;
}
