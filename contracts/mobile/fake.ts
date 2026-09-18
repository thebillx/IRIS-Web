import { createHash } from 'node:crypto';
import { redactOutput } from '../../apps/runtime/src/output-redaction.ts';
import type { Device, Target, Operation, Evidence, MobileAdapter, SensitiveArtifact } from './contract.ts';
import { mobileEffects, validateOperation } from './policy.ts';

const fail = (code: string): never => { throw new Error(code); };
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value);
export const effects = mobileEffects;

/** In-memory acceptance model, deliberately not a production authority engine. */
export class FakeMobileAdapter implements MobileAdapter {
  inventory: Device[];
  readonly calls: string[] = [];
  readonly #bindings = new Map<string, Readonly<Device>>();
  readonly #sessions = new Map<string, Readonly<Device>>();
  get bindingCount(): number { return this.#bindings.size; }
  granted = false;
  elapsedMs = 0;
  duringOperation: () => void = () => {};
  constructor(devices: Device[] = []) { this.inventory = devices.map(d => ({ ...d })); }
  async devices(): Promise<readonly Device[]> { return this.inventory.map(d => ({ ...d })); }
  async status() { return { ready: true }; }
  bind(id: string, serial: string): void {
    if (!validId(id) || this.#bindings.has(id)) fail('IMMUTABLE_BINDING');
    this.#bindings.set(id, Object.freeze({ ...this.resolve({ deviceSerial: serial }) }));
  }
  private resolve(target: Target): Device {
    if (!target || Object.keys(target).length !== 1) fail('EXPLICIT_DEVICE_REQUIRED');
    let pinned: Readonly<Device> | undefined;
    let serial: string | undefined;
    if ('deviceSerial' in target) serial = target.deviceSerial;
    else { pinned = this.#bindings.get(target.deviceBindingId); serial = pinned?.serial; }
    if (!validId(serial)) fail('EXPLICIT_DEVICE_REQUIRED');
    const matches = this.inventory.filter(d => d.serial === serial);
    if (matches.length !== 1) fail('DEVICE_MISSING_OR_AMBIGUOUS');
    const device = matches[0]!;
    if (device.state !== 'device') fail('DEVICE_UNAVAILABLE');
    if (pinned && pinned.connectionId !== device.connectionId) fail('STALE_BINDING');
    return device;
  }
  async execute(target: Target, request: Operation, context: {
    operationId: string; jobId?: string; timeoutMs: number; signal: AbortSignal;
  }): Promise<{ evidence: Evidence; artifact?: SensitiveArtifact }> {
    const device = { ...this.resolve(target) };
    validateOperation(request);
    if (!this.granted) fail('AUTHORIZATION_REQUIRED');
    if (!validId(context.operationId) || (context.jobId !== undefined && !validId(context.jobId)) ||
        !Number.isSafeInteger(context.timeoutMs) || context.timeoutMs < 1 || context.timeoutMs > 300_000) fail('INVALID_CONTEXT');
    if (context.signal.aborted) fail('CANCELLED');
    const op = request.operation;
    if ('sessionId' in op) {
      const session = this.#sessions.get(op.sessionId);
      if (!session || session.serial !== device.serial || session.connectionId !== device.connectionId) fail('STALE_SESSION');
    }
    let apkSha256: string | undefined;
    if (op.kind === 'install') {
      apkSha256 = createHash('sha256').update(Uint8Array.from(op.apk)).digest('hex');
      if (apkSha256 !== op.expectedSha256) fail('APK_HASH_MISMATCH');
    }
    this.calls.push(device.serial);
    this.duringOperation();
    if (context.signal.aborted) fail('CANCELLED');
    if (this.elapsedMs >= context.timeoutMs) fail('TIMEOUT');
    const after = this.resolve({ deviceSerial: device.serial });
    if (after.connectionId !== device.connectionId) fail('DEVICE_REPLACED');
    if (op.kind === 'session') {
      if (op.action === 'create') this.#sessions.set(context.operationId, Object.freeze(device));
      else if (op.action === 'delete') this.#sessions.delete(op.sessionId);
      else fail('OPERATION_DENIED');
    }
    const evidence: Evidence = { serial: device.serial, connectionId: device.connectionId, kind: device.kind,
      operationId: context.operationId, ...(context.jobId ? { jobId: context.jobId } : {}), ...(apkSha256 ? { apkSha256 } : {}) };
    if (['screenshot', 'source', 'logcat'].includes(op.kind)) return { evidence,
      artifact: { sensitivity: 'restricted', retention: 'memory-only', redaction: 'required-before-export', evidence } };
    return { evidence };
  }
}
export const redactLog = (text: string, secrets: readonly string[]) => redactOutput(text, secrets);
