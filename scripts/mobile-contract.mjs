import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mode = process.argv[2];

function run(args) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.signal) process.kill(process.pid, result.signal);
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1);
}

if (mode === 'test') {
  run([
    '--experimental-transform-types',
    '--test',
    'contracts/mobile/acceptance.test.mjs',
    'contracts/mobile/security.acceptance.test.mjs',
    'contracts/mobile/governed.acceptance.test.mjs',
    'contracts/mobile/integration.acceptance.test.mjs',
    'contracts/mobile/e2e.acceptance.test.mjs',
  ]);
} else if (mode === 'typecheck') {
  run([
    path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--noEmit',
    '--strict',
    '--noUncheckedIndexedAccess',
    '--exactOptionalPropertyTypes',
    '--skipLibCheck',
    '--target', 'es2024',
    '--module', 'nodenext',
    '--moduleResolution', 'nodenext',
    '--allowImportingTsExtensions',
    '--typeRoots', path.join(repoRoot, 'apps', 'runtime', 'node_modules', '@types'),
    'contracts/mobile/contract.ts',
    'contracts/mobile/policy.ts',
    'contracts/mobile/fake.ts',
    'contracts/mobile/governed.ts',
    'contracts/mobile/integration.ts',
  ]);
} else {
  throw new Error('Usage: node scripts/mobile-contract.mjs [test|typecheck]');
}
