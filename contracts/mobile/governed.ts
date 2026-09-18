import { createHash } from 'node:crypto';
import { redactOutput } from '../../apps/runtime/src/output-redaction.ts';
import type { Device, Effect, Evidence, MobileAdapter, Operation, SensitiveArtifact, Target } from './contract.ts';
import { mobileEffects, validateOperation } from './policy.ts';

const fail = (code: string): never => { throw new Error(code); };
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);

export interface AdbTransport {
  devices(signal: AbortSignal): Promise<readonly Device[]>;
  packageInfo(serial: string, packageName: string, signal: AbortSignal): Promise<void>;
  activity(serial: string, action: 'inspect' | 'start', component: string, signal: AbortSignal): Promise<void>;
  install(serial: string, apk: Uint8Array, signal: AbortSignal): Promise<void>;
  screenshot(serial: string, signal: AbortSignal): Promise<Uint8Array>;
  logcat(serial: string, maxBytes: number, signal: AbortSignal): Promise<string>;
  androidVersion(serial: string, signal: AbortSignal): Promise<string>;
}

export interface AppiumTransport {
  readonly endpoint: string;
  status(signal: AbortSignal): Promise<{ ready: boolean }>;
  createSession(input: { readonly udid: string }, signal: AbortSignal): Promise<{ sessionId: string }>;
  deleteSession(sessionId: string, signal: AbortSignal): Promise<void>;
  source(sessionId: string, signal: AbortSignal): Promise<string>;
  screenshot(sessionId: string, signal: AbortSignal): Promise<Uint8Array>;
  contexts(sessionId: string, signal: AbortSignal): Promise<readonly string[]>;
}

export interface MobileAuthority {
  binding(bindingId: string): Promise<Readonly<{ serial: string; connectionId: string }> | null>;
  authorize(input: Readonly<{
    device: Device;
    operation: Operation;
    effects: readonly Effect[];
    operationId: string;
    jobId?: string;
  }>): Promise<Readonly<{ allowed: true; redactionValues: readonly string[] }>>;
}

export interface MobileArtifactSink {
  commit(input: Readonly<{
    kind: 'screenshot' | 'source' | 'logcat';
    mime: string;
    bytes: Uint8Array;
    evidence: Evidence;
    sensitivity: 'restricted';
    retention: 'memory-only';
    redaction: 'required-before-export';
  }>): Promise<SensitiveArtifact>;
}

type Context = Readonly<{
  operationId: string;
  jobId?: string;
  timeoutMs: number;
  signal: AbortSignal;
}>;

type SessionRecord = Readonly<{
  logicalSessionId: string;
  actualSessionId: string;
  serial: string;
  connectionId: string;
}>;

function loopbackEndpoint(value: string): URL {
  const url = (() => {
    try { return new URL(value); } catch { return fail('APPIUM_ENDPOINT_DENIED'); }
  })();
  if (!['http:', 'https:'].includes(url.protocol)
      || !['127.0.0.1', '::1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password) fail('APPIUM_ENDPOINT_DENIED');
  return url;
}

function artifactEvidence(device: Device, context: Context, apkSha256?: string): Evidence {
  return {
    serial: device.serial,
    connectionId: device.connectionId,
    kind: device.kind,
    operationId: context.operationId,
    ...(context.jobId ? { jobId: context.jobId } : {}),
    ...(apkSha256 ? { apkSha256 } : {}),
  };
}

export class GovernedMobileAdapter implements MobileAdapter {
  readonly #sessions = new Map<string, SessionRecord>();

  constructor(
    private readonly adb: AdbTransport,
    private readonly appium: AppiumTransport,
    private readonly authority: MobileAuthority,
    private readonly artifacts: MobileArtifactSink,
  ) {
    loopbackEndpoint(appium.endpoint);
  }

  async devices(): Promise<readonly Device[]> {
    const controller = new AbortController();
    const devices = await this.adb.devices(controller.signal);
    return devices.map(device => Object.freeze({ ...device }));
  }

  async status(): Promise<{ ready: boolean }> {
    loopbackEndpoint(this.appium.endpoint);
    const controller = new AbortController();
    return this.appium.status(controller.signal);
  }

  async execute(target: Target, operation: Operation, context: Context): Promise<{ evidence: Evidence; artifact?: SensitiveArtifact }> {
    validateOperation(operation);
    this.validateContext(context);
    const device = await this.resolve(target, context.signal);
    const effects = mobileEffects(operation);
    const authorization = await this.authority.authorize({
      device,
      operation,
      effects,
      operationId: context.operationId,
      ...(context.jobId === undefined ? {} : { jobId: context.jobId }),
    });
    if (!authorization?.allowed) fail('AUTHORIZATION_REQUIRED');

    const op = operation.operation;
    const session = 'sessionId' in op ? this.requireSession(op.sessionId, device) : null;
    let apkSha256: string | undefined;
    if (op.kind === 'install') {
      apkSha256 = createHash('sha256').update(Uint8Array.from(op.apk)).digest('hex');
      if (apkSha256 !== op.expectedSha256) fail('APK_HASH_MISMATCH');
    }

    let artifact: SensitiveArtifact | undefined;
    let createdActualSessionId: string | null = null;
    await this.withDeadline(context, async (signal) => {
      if (operation.adapter === 'adb') {
        if (op.kind === 'package_info') await this.adb.packageInfo(device.serial, op.packageName, signal);
        else if (op.kind === 'activity') await this.adb.activity(device.serial, op.action, op.component, signal);
        else if (op.kind === 'install') await this.adb.install(device.serial, Uint8Array.from(op.apk), signal);
        else if (op.kind === 'screenshot') {
          const bytes = await this.adb.screenshot(device.serial, signal);
          artifact = await this.commitArtifact('screenshot', 'image/png', bytes, device, context, apkSha256);
        } else if (op.kind === 'logcat') {
          const text = await this.adb.logcat(device.serial, op.maxBytes, signal);
          const redacted = redactOutput(text, authorization.redactionValues);
          artifact = await this.commitArtifact('logcat', 'text/plain; charset=utf-8', new TextEncoder().encode(redacted), device, context, apkSha256);
        } else if (op.kind === 'shell') await this.adb.androidVersion(device.serial, signal);
        else fail('OPERATION_DENIED');
      } else if (operation.adapter === 'appium') {
        loopbackEndpoint(this.appium.endpoint);
        if (op.kind === 'session') {
          if (op.action === 'create') {
            if (this.#sessions.has(context.operationId)) fail('SESSION_ID_CONFLICT');
            const created = await this.appium.createSession({ udid: device.serial }, signal);
            if (!validId(created.sessionId)) fail('INVALID_APPIUM_SESSION');
            createdActualSessionId = created.sessionId;
            this.#sessions.set(context.operationId, Object.freeze({
              logicalSessionId: context.operationId,
              actualSessionId: created.sessionId,
              serial: device.serial,
              connectionId: device.connectionId,
            }));
          } else if (op.action === 'delete') {
            const activeSession = session ?? fail('STALE_SESSION');
            await this.appium.deleteSession(activeSession.actualSessionId, signal);
            this.#sessions.delete(op.sessionId);
          } else fail('OPERATION_DENIED');
        } else {
          const activeSession = session ?? fail('STALE_SESSION');
          if (op.kind === 'source') {
            const source = await this.appium.source(activeSession.actualSessionId, signal);
            artifact = await this.commitArtifact('source', 'application/xml; charset=utf-8', new TextEncoder().encode(source), device, context, apkSha256);
          } else if (op.kind === 'screenshot') {
            const bytes = await this.appium.screenshot(activeSession.actualSessionId, signal);
            artifact = await this.commitArtifact('screenshot', 'image/png', bytes, device, context, apkSha256);
          } else if (op.kind === 'contexts') {
            await this.appium.contexts(activeSession.actualSessionId, signal);
          } else fail('OPERATION_DENIED');
        }
      } else fail('ADAPTER_DENIED');
    });

    let after: Device;
    try {
      after = await this.resolve({ deviceSerial: device.serial }, context.signal);
    } catch (error) {
      if (createdActualSessionId !== null) await this.bestEffortDeleteSession(createdActualSessionId);
      throw error;
    }
    if (after.connectionId !== device.connectionId) {
      if (createdActualSessionId !== null) await this.bestEffortDeleteSession(createdActualSessionId);
      fail('DEVICE_REPLACED');
    }

    const evidence = artifactEvidence(device, context, apkSha256);
    return { evidence, ...(artifact === undefined ? {} : { artifact }) };
  }

  private validateContext(context: Context): void {
    if (!validId(context.operationId)
        || (context.jobId !== undefined && !validId(context.jobId))
        || !Number.isSafeInteger(context.timeoutMs)
        || context.timeoutMs < 1
        || context.timeoutMs > 300_000) fail('INVALID_CONTEXT');
    if (context.signal.aborted) fail('CANCELLED');
  }

  private async resolve(target: Target, signal: AbortSignal): Promise<Device> {
    if (!target || Object.keys(target).length !== 1) fail('EXPLICIT_DEVICE_REQUIRED');
    let pinned: Readonly<{ serial: string; connectionId: string }> | null = null;
    let serial: string | undefined;
    if ('deviceSerial' in target) serial = target.deviceSerial;
    else {
      if (!validId(target.deviceBindingId)) fail('EXPLICIT_DEVICE_REQUIRED');
      pinned = await this.authority.binding(target.deviceBindingId);
      serial = pinned?.serial;
    }
    if (!validId(serial)) fail('EXPLICIT_DEVICE_REQUIRED');
    const inventory = await this.adb.devices(signal);
    const matches = inventory.filter(device => device.serial === serial);
    if (matches.length !== 1) fail('DEVICE_MISSING_OR_AMBIGUOUS');
    const device = matches[0]!;
    if (device.state !== 'device') fail('DEVICE_UNAVAILABLE');
    if (pinned !== null && pinned.connectionId !== device.connectionId) fail('STALE_BINDING');
    return Object.freeze({ ...device });
  }

  private requireSession(logicalSessionId: string, device: Device): SessionRecord {
    const record = this.#sessions.get(logicalSessionId);
    if (!record || record.serial !== device.serial || record.connectionId !== device.connectionId) fail('STALE_SESSION');
    return record!;
  }

  private async withDeadline<T>(context: Context, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, context.timeoutMs);
    try {
      const result = await task(controller.signal);
      if (context.signal.aborted) fail('CANCELLED');
      if (timedOut) fail('TIMEOUT');
      return result;
    } catch (error) {
      if (context.signal.aborted) fail('CANCELLED');
      if (timedOut) fail('TIMEOUT');
      throw error;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', onAbort);
    }
  }

  private async commitArtifact(
    kind: 'screenshot' | 'source' | 'logcat',
    mime: string,
    bytes: Uint8Array,
    device: Device,
    context: Context,
    apkSha256?: string,
  ): Promise<SensitiveArtifact> {
    const evidence = artifactEvidence(device, context, apkSha256);
    return this.artifacts.commit({
      kind,
      mime,
      bytes: Uint8Array.from(bytes),
      evidence,
      sensitivity: 'restricted',
      retention: 'memory-only',
      redaction: 'required-before-export',
    });
  }

  private async bestEffortDeleteSession(actualSessionId: string): Promise<void> {
    try {
      const controller = new AbortController();
      await this.appium.deleteSession(actualSessionId, controller.signal);
    } catch {
      // Failure is intentionally not converted into a successful mobile outcome.
    }
  }
}
