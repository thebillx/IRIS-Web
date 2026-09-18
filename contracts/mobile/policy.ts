import type { Effect, Operation } from './contract.ts';

const fail = (code: string): never => { throw new Error(code); };

export function mobileEffects(request: Operation): readonly Effect[] {
  const op = request.operation;
  if (request.adapter === 'adb') {
    if (op.kind === 'shell') {
      if (op.profile !== 'android-properties-v1' || op.command !== 'get_android_version') fail('SHELL_POLICY_DENIED');
      return ['READ', 'EXECUTE'];
    }
    if (op.kind === 'install' || (op.kind === 'activity' && op.action === 'start')) return ['READ', 'WRITE', 'EXECUTE'];
    if (!['package_info', 'activity', 'screenshot', 'logcat'].includes(op.kind)) fail('OPERATION_DENIED');
  } else if (request.adapter === 'appium') {
    if (op.kind === 'session') return ['READ', 'WRITE', 'EXECUTE'];
    if (!['source', 'screenshot', 'contexts'].includes(op.kind)) fail('OPERATION_DENIED');
  } else fail('ADAPTER_DENIED');
  return ['READ'];
}

export function validateOperation(request: Operation): void {
  mobileEffects(request);
  const op = request.operation;
  if ('packageName' in op && !/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(op.packageName)) fail('INVALID_PACKAGE');
  if (op.kind === 'activity' && (!['inspect', 'start'].includes(op.action) || !/^[A-Za-z0-9_.]+\/[A-Za-z0-9_.]+$/.test(op.component))) fail('INVALID_ACTIVITY');
  if (op.kind === 'logcat' && (!Number.isSafeInteger(op.maxBytes) || op.maxBytes < 1 || op.maxBytes > 1_048_576)) fail('INVALID_LIMIT');
  if ('sessionId' in op && (typeof op.sessionId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(op.sessionId))) fail('INVALID_SESSION');
}
