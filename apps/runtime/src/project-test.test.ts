import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDeclaredProjectTest } from './project-test.js';

const roots: string[] = [];
afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(testScript: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'iris-governed-project-test-'));
  roots.push(root);
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: testScript } }));
  return root;
}

describe('governed declared project tests', () => {
  it('returns bounded success and failure results without arbitrary command input', async () => {
    const passing = await runDeclaredProjectTest(await fixture("node -e \"console.log('pass')\""));
    expect(passing).toMatchObject({ passed: true, exitCode: 0, timedOut: false });
    expect(passing.stdout).toContain('pass');

    const failing = await runDeclaredProjectTest(await fixture("node -e \"console.error('expected-failure'); process.exit(3)\""));
    expect(failing).toMatchObject({ passed: false, exitCode: 3, timedOut: false });
    expect(failing.stderr).toContain('expected-failure');
  });

  it('does not inherit credential-like parent environment values', async () => {
    process.env.OPENAI_API_KEY = 'SHOULD_NOT_REACH_PROJECT_TEST';
    const result = await runDeclaredProjectTest(await fixture("node -e \"console.log(process.env.OPENAI_API_KEY || 'credential-absent')\""));
    expect(result.passed).toBe(true);
    expect(result.stdout).toContain('credential-absent');
    expect(result.stdout).not.toContain('SHOULD_NOT_REACH_PROJECT_TEST');
  });
});
