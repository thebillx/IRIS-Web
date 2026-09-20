import { resolveRuntimeDataRoot } from '../data-root.js';
import {
  persistAdoCredential,
  persistAdoRuntimeBinding,
  readAdoBindingStatus,
  type AdoRuntimeBinding,
} from './runtime-binding.js';

const command = process.argv[2];

try {
  const dataRoot = await resolveRuntimeDataRoot();
  if (command === 'credential-set') {
    requireFlag('--token-stdin');
    const credentialRef = required('--credential-ref');
    const kind = required('--kind');
    if (kind !== 'PAT' && kind !== 'BEARER') throw new Error('--kind must be PAT or BEARER');
    const secret = await readStdin(4096);
    await persistAdoCredential(dataRoot, { credentialRef, kind, secret: secret.trim() });
    process.stdout.write(JSON.stringify({
      status: 'CREDENTIAL_STORED',
      credentialRef,
      kind,
      secretPrinted: false,
    }, null, 2) + '\n');
  } else if (command === 'binding-set') {
    requireFlag('--manifest-stdin');
    const input = await readStdin(64 * 1024);
    let value: unknown;
    try { value = JSON.parse(input); } catch { throw new Error('Binding manifest must be valid JSON'); }
    await persistAdoRuntimeBinding(dataRoot, value as AdoRuntimeBinding);
    const irisProjectId = typeof (value as { irisProjectId?: unknown })?.irisProjectId === 'string'
      ? (value as { irisProjectId: string }).irisProjectId
      : '';
    process.stdout.write(JSON.stringify({
      status: 'BINDING_STORED',
      binding: await readAdoBindingStatus(dataRoot, irisProjectId),
      secretPrinted: false,
    }, null, 2) + '\n');
  } else if (command === 'status') {
    const irisProjectId = required('--iris-project-id');
    process.stdout.write(JSON.stringify(await readAdoBindingStatus(dataRoot, irisProjectId), null, 2) + '\n');
  } else {
    throw new Error(
      'Usage: ado:binding <credential-set --credential-ref <ref> --kind <PAT|BEARER> --token-stdin'
      + ' | binding-set --manifest-stdin | status --iris-project-id <uuid>>',
    );
  }
} catch (error) {
  const code = error instanceof Error && 'code' in error
    ? String((error as { readonly code?: unknown }).code ?? 'ADO_BINDING_FAILED')
    : 'ADO_BINDING_FAILED';
  const message = error instanceof Error ? error.message : 'ADO binding command failed';
  process.stderr.write(`ADO_BINDING_FAILED code=${code} message=${message}\n`);
  process.exitCode = 1;
}

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (value === undefined || value.length === 0 || value.length > 2048 || /[\0\r\n]/.test(value)) {
    throw new Error('Missing or invalid ' + name);
  }
  return value;
}

function requireFlag(name: string): void {
  if (!process.argv.includes(name)) throw new Error('Missing ' + name);
}

async function readStdin(maxBytes: number): Promise<string> {
  let value = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    value += chunk;
    if (Buffer.byteLength(value, 'utf8') > maxBytes) throw new Error('stdin exceeds the bounded input limit');
  }
  if (value.trim().length === 0) throw new Error('stdin is empty');
  return value;
}
