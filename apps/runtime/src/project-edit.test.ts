import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { secureProjectFileEdit } from './macos-safety.js';
import { inspectProjectTarget } from './project-path.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe('governed minimal project edit', () => {
  it('previews and atomically applies one exact UTF-8 replacement with hashes', async () => {
    const root = await fixture('alpha\nneedle\nomega\n');
    const target = path.join(root, 'README.md');
    const expected = hash('alpha\nneedle\nomega\n');
    const preview = await secureProjectFileEdit(root, target, 'needle', 'changed', expected, true);
    expect(preview).toMatchObject({ dryRun: true, changed: true, beforeSha256: expected, bytesBefore: 19, bytesAfter: 20, matchCount: 1 });
    await expect(readFile(target, 'utf8')).resolves.toBe('alpha\nneedle\nomega\n');

    const applied = await secureProjectFileEdit(root, target, 'needle', 'changed', expected);
    expect(applied).toMatchObject({ dryRun: false, changed: true, beforeSha256: expected, afterSha256: hash('alpha\nchanged\nomega\n') });
    await expect(readFile(target, 'utf8')).resolves.toBe('alpha\nchanged\nomega\n');
  });

  it('rejects stale, missing, ambiguous, malformed, and escaped edits without changing bytes', async () => {
    const root = await fixture('needle\nneedle\n');
    const target = path.join(root, 'README.md');
    const original = await readFile(target, 'utf8');
    const expected = hash(original);
    await expect(secureProjectFileEdit(root, target, 'needle', 'new', hash('other\n'))).rejects.toThrow(/precondition/i);
    await expect(secureProjectFileEdit(root, target, 'absent', 'new', expected)).rejects.toThrow(/not found/i);
    await expect(secureProjectFileEdit(root, target, 'needle', 'new', expected)).rejects.toThrow(/ambiguous/i);
    await expect(secureProjectFileEdit(root, target, 'needle', 'new', 'not-a-hash')).rejects.toThrow(/SHA-256/i);
    await expect(secureProjectFileEdit(root, path.join(root, '..', 'outside.md'), 'needle', 'new', expected)).rejects.toThrow();
    await expect(readFile(target, 'utf8')).resolves.toBe(original);
  });

  it('supports an empty replacement and rejects directories as file-edit targets', async () => {
    const root = await fixture('keep this\nremove this\n');
    const target = path.join(root, 'README.md');
    const expected = hash('keep this\nremove this\n');
    await expect(secureProjectFileEdit(root, target, 'remove this\n', '', expected)).resolves.toMatchObject({ changed: true, bytesAfter: 10 });
    await expect(readFile(target, 'utf8')).resolves.toBe('keep this\n');

    const directory = path.join(root, 'directory');
    await mkdir(directory);
    await expect(inspectProjectTarget(root, directory, 'file-edit')).resolves.toMatchObject({ valid: false, reason: 'Target must be a regular file' });
  });
});

async function fixture(content: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'iris-project-edit-')));
  roots.push(root);
  await writeFile(path.join(root, 'README.md'), content, { encoding: 'utf8', mode: 0o600 });
  return root;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
