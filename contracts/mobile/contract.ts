/** Contract-only surface. No process, network, filesystem, or runtime registration. */
export type Device = Readonly<{
  serial: string; state: 'device' | 'offline' | 'unauthorized';
  transport: 'usb' | 'emulator' | 'tcp'; model: string | null;
  manufacturer: string | null; androidVersion: string | null; apiLevel: number | null;
  kind: 'emulator' | 'physical'; connectionId: string;
}>;
export type Target = { deviceSerial: string; deviceBindingId?: never }
  | { deviceBindingId: string; deviceSerial?: never };
export type AdbOperation =
  | { kind: 'package_info'; packageName: string }
  | { kind: 'activity'; action: 'inspect' | 'start'; component: string }
  | { kind: 'install'; apk: Uint8Array; expectedSha256: string }
  | { kind: 'screenshot' }
  | { kind: 'logcat'; maxBytes: number }
  | { kind: 'shell'; profile: 'android-properties-v1'; command: 'get_android_version' };
export type AppiumOperation = { kind: 'session'; action: 'create' }
  | { kind: 'session'; action: 'delete'; sessionId: string }
  | { kind: 'source' | 'screenshot' | 'contexts'; sessionId: string };
export type Operation = { adapter: 'adb'; operation: AdbOperation }
  | { adapter: 'appium'; operation: AppiumOperation };
export type Effect = 'READ' | 'WRITE' | 'EXECUTE';
export type Evidence = Readonly<{
  serial: string; connectionId: string; kind: Device['kind'];
  operationId: string; jobId?: string; apkSha256?: string;
}>;
export type SensitiveArtifact = Readonly<{
  sensitivity: 'restricted'; retention: 'memory-only'; redaction: 'required-before-export';
  evidence: Evidence;
}>;
export interface MobileAdapter {
  devices(): Promise<readonly Device[]>; // READ only; never establishes a binding.
  status(): Promise<{ ready: boolean }>; // Appium server status, no session creation.
  execute(target: Target, operation: Operation, context: {
    operationId: string; jobId?: string; timeoutMs: number; signal: AbortSignal;
  }): Promise<{ evidence: Evidence; artifact?: SensitiveArtifact }>;
}
