import { describe, expect, it } from 'vitest';
import type { CapabilityId, WorkerConcurrencyPolicy, WorkerResourceBudget } from '@iris/domain';
import {
  applyWorkerPreset,
  workerPreset,
  type WorkerPresetAuthorityBounds,
} from './presets.js';

function parentBounds(overrides: Partial<WorkerPresetAuthorityBounds> = {}): WorkerPresetAuthorityBounds {
  const resourceBudget: WorkerResourceBudget = {
    maxRuntimeMs: 60 * 60_000,
    maxJobs: 8,
    maxArtifacts: 100,
    maxOutputBytes: 64 * 1024 * 1024,
  };
  const concurrencyPolicy: WorkerConcurrencyPolicy = {
    maxParallelCapabilities: 8,
    mutablePathOwnership: 'EXCLUSIVE',
    allowParallelReads: true,
  };
  return {
    allowedCapabilities: [
      'project.search',
      'fs.list',
      'fs.stat',
      'fs.read',
      'fs.write',
      'fs.edit',
      'fs.hash',
      'fs.find',
      'shell.run',
      'system.sudo',
    ] as readonly CapabilityId[],
    allowedPaths: ['apps/runtime/**'],
    readOnlyPaths: ['apps/runtime/**'],
    mutablePaths: ['apps/runtime/generated/**'],
    allowedProcesses: ['node-script', 'pnpm-script'],
    approvalPolicy: 'OWNER_REQUIRED',
    resourceBudget,
    concurrencyPolicy,
    ...overrides,
  };
}

describe('IRIS multi-worker M12 role presets', () => {
  it('defines CODE, QA, RESEARCH, and DOCS as bounded convenience templates', () => {
    for (const role of ['CODE', 'QA', 'RESEARCH', 'DOCS'] as const) {
      const preset = workerPreset(role);
      expect(preset.role).toBe(role);
      expect(preset.mutationMode).toBe('READ_ONLY_V1');
      expect(preset.capabilityAllowlist).toContain('fs.read');
      expect(preset.capabilityAllowlist).not.toContain('system.sudo');
      expect(preset.processAllowlist).toEqual([]);
    }
  });

  it('intersects capability authority and never adds a capability absent from the parent envelope', () => {
    const parent = parentBounds({
      allowedCapabilities: ['fs.read', 'fs.write', 'system.sudo'],
    });
    const effective = applyWorkerPreset('CODE', parent);
    expect(effective.allowedCapabilities).toEqual(['fs.read']);
    expect(effective.allowedCapabilities).not.toContain('project.search');
    expect(effective.allowedCapabilities).not.toContain('fs.write');
    expect(effective.allowedCapabilities).not.toContain('system.sudo');
  });

  it('inherits path boundaries exactly and removes mutable/process authority in V1', () => {
    const parent = parentBounds();
    const effective = applyWorkerPreset('QA', parent);
    expect(effective.allowedPaths).toEqual(parent.allowedPaths);
    expect(effective.readOnlyPaths).toEqual(parent.readOnlyPaths);
    expect(effective.mutablePaths).toEqual([]);
    expect(effective.allowedProcesses).toEqual([]);
    expect(effective.concurrencyPolicy.mutablePathOwnership).toBe('READ_ONLY');
  });

  it('clamps resource and concurrency budgets downward without weakening owner approval', () => {
    const parent = parentBounds();
    const effective = applyWorkerPreset('RESEARCH', parent);
    const preset = workerPreset('RESEARCH');
    expect(effective.resourceBudget).toEqual(preset.maxResourceBudget);
    expect(effective.concurrencyPolicy.maxParallelCapabilities).toBe(preset.maxConcurrency);
    expect(effective.approvalPolicy).toBe('OWNER_REQUIRED');

    const alreadyNarrow = applyWorkerPreset('DOCS', parentBounds({
      resourceBudget: {
        maxRuntimeMs: 10_000,
        maxJobs: 0,
        maxArtifacts: 1,
        maxOutputBytes: 1024,
      },
      concurrencyPolicy: {
        maxParallelCapabilities: 1,
        mutablePathOwnership: 'READ_ONLY',
        allowParallelReads: false,
      },
      approvalPolicy: 'INHERIT_MISSION',
    }));
    expect(alreadyNarrow.resourceBudget).toEqual({
      maxRuntimeMs: 10_000,
      maxJobs: 0,
      maxArtifacts: 1,
      maxOutputBytes: 1024,
    });
    expect(alreadyNarrow.concurrencyPolicy).toEqual({
      maxParallelCapabilities: 1,
      mutablePathOwnership: 'READ_ONLY',
      allowParallelReads: false,
    });
    expect(alreadyNarrow.approvalPolicy).toBe('INHERIT_MISSION');
  });

  it('fails closed for unknown preset roles', () => {
    expect(() => workerPreset('OWNER')).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
    expect(() => applyWorkerPreset('GENERIC', parentBounds())).toThrowError(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });
});
