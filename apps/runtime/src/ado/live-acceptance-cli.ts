import { resolveRuntimeDataRoot } from '../data-root.js';
import {
  persistAdoLiveAcceptance,
  readPatFromStdin,
  runAdoLiveReadAcceptance,
  type AdoLiveAcceptanceTarget,
} from './live-acceptance.js';

function required(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : undefined;
  if (!value) throw new Error('Missing ' + name);
  return value;
}

function positive(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid ' + name);
  return value;
}

async function main(): Promise<void> {
  if (!process.argv.includes('--token-stdin')) throw new Error('Use --token-stdin; credentials are never accepted as argv');
  const target: AdoLiveAcceptanceTarget = {
    organization: required('--organization'),
    project: required('--project'),
    teamName: required('--team'),
    level1WorkItemId: positive('--level1-work-item'),
    storyWorkItemId: positive('--story-work-item'),
  };
  const pat = await readPatFromStdin();
  const result = await runAdoLiveReadAcceptance(target, pat);
  const dataRoot = await resolveRuntimeDataRoot();
  const persisted = await persistAdoLiveAcceptance(dataRoot, result);
  process.stdout.write(JSON.stringify({
    status: 'PASS',
    receipt: result.receipt,
    privateReceiptPath: persisted.receiptPath,
    privateSnapshotPath: persisted.snapshotPath,
  }, null, 2) + '\n');
}

main().catch((error: unknown) => {
  const code = error instanceof Error && 'code' in error ? String((error as { readonly code?: unknown }).code) : 'ADO_LIVE_ACCEPTANCE_FAILED';
  process.stderr.write('ADO_LIVE_ACCEPTANCE_FAILED code=' + code + '\n');
  process.exitCode = 1;
});
