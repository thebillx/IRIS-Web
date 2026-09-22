import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeHealth } from '@iris/domain';
import { FoundationStateStore } from '../persistence.js';
import { VNextResourceRegistry } from '../resource-registry.js';
import { RuntimeState } from '../state.js';
import { MultiWorkerRoutingService } from '../multi-worker/service.js';
import { MultiWorkerStore } from '../multi-worker/store.js';
import { executeSecurityAuditTool } from '../mcp-security-audit.js';
import { SecurityAuditService } from './service.js';
import { SecurityAuditStore } from './store.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-security-audit-source-'));
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'iris-security-audit-data-'));
  roots.push(sourceRoot, dataRoot);
  const projectRoot = path.join(sourceRoot, 'iris');
  await mkdir(path.join(projectRoot, 'apps/runtime/src'), { recursive: true });
  await writeFile(
    path.join(projectRoot, 'apps/runtime/src/capability-service.ts'),
    Array.from({ length: 220 }, (_, index) => `line ${index + 1}\n`).join(''),
    'utf8',
  );
  const state = new RuntimeState(new FoundationStateStore(dataRoot));
  const project = await state.registerProject('iris', projectRoot);
  const session = state.createSession('chatgpt-security', 'iris-tunnel-service', 'other');
  await state.setSessionCurrentProject(session.id, session.clientId, project.id);
  const mission = await state.createMission(session.clientId, session.id, 'Security audit test', 'CHATGPT');
  const resources = new VNextResourceRegistry(state, dataRoot);
  const workspace = await resources.primaryWorkspace(project.id);
  const multiWorker = new MultiWorkerRoutingService(state, resources, new MultiWorkerStore(dataRoot), undefined, () => '2026-09-22T05:30:00.000Z');
  const health = (): RuntimeHealth => ({
    status: 'ready',
    version: '0.0.0',
    platform: 'darwin',
    runtimeId: '11111111-1111-4111-8111-111111111111',
    instanceId: '22222222-2222-4222-8222-222222222222',
    pid: 123,
    uptimeMs: 1000,
    authority: 'owned',
    connectedClients: 1,
    connectedSessions: 1,
    agentExecutorType: 'local-development-executor',
    productionModelConnected: false,
    apiUrl: 'http://127.0.0.1:43110',
    mcpUrl: 'http://127.0.0.1:43110/mcp',
    machineId: '33333333-3333-4333-8333-333333333333',
    identityState: 'COHERENT',
    identityCode: 'COHERENT',
    tunnelBindings: [{
      connectorProfile: 'FULL',
      tunnelId: 'tunnel_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      deploymentEpoch: 13,
      catalogHash: `sha256:${'7'.repeat(64)}`,
      leaseGeneration: 1,
      machineId: '33333333-3333-4333-8333-333333333333',
      runtimeId: '11111111-1111-4111-8111-111111111111',
    }],
  });
  const store = new SecurityAuditStore(dataRoot);
  const service = new SecurityAuditService(state, multiWorker, resources, store, health, () => '2026-09-22T05:30:00.000Z');
  return { state, project, session, mission, resources, workspace, multiWorker, store, service, projectRoot };
}

async function createRun(f: Awaited<ReturnType<typeof fixture>>, title = 'Trust boundary') {
  return f.service.createRun({
    clientId: f.session.clientId,
    sessionId: f.session.id,
    projectId: f.project.id,
    workspaceId: f.workspace.workspaceId,
    missionId: f.mission.id,
    coverageTargets: [{ key: 'trust-boundary', title, scope: 'Inspect project-bound capability and runtime authority enforcement.' }],
  });
}

function candidate(overrides: Partial<{
  title: string; category: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; location: string; summary: string; evidenceRefs: readonly string[];
}> = {}) {
  return {
    title: overrides.title ?? 'Unsafe trust-boundary bypass',
    category: overrides.category ?? 'AUTHORIZATION',
    severity: overrides.severity ?? 'HIGH',
    location: overrides.location ?? 'apps/runtime/src/capability-service.ts:100',
    summary: overrides.summary ?? 'A project-scoped operation can cross a trust boundary.',
    evidenceRefs: overrides.evidenceRefs ?? ['file:apps/runtime/src/capability-service.ts#L100-L120'],
  };
}

async function hunterWithFinding(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await createRun(f);
  const target = created.coverageTargets[0]!;
  return f.service.recordHunterReport({
    clientId: f.session.clientId,
    sessionId: f.session.id,
    projectId: f.project.id,
    auditRunId: created.run.id,
    coverageTargetId: target.id,
    coverageStatus: 'COVERED',
    summary: 'Hunter inspected the trust boundary.',
    evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L80-L99'],
    filesRead: ['apps/runtime/src/capability-service.ts'],
    findings: [candidate()],
  });
}

describe('Security Audit Engine Phase 2', () => {
  it('runs Hunter -> independent Verifier -> Proof Gate -> Decision Package using durable Multi-Worker state', async () => {
    const f = await fixture();
    const hunted = await hunterWithFinding(f);
    expect(hunted.run.state).toBe('VERIFYING');
    expect(hunted.findings).toHaveLength(1);
    expect(hunted.findings[0]).toMatchObject({ state: 'CANDIDATE', occurrences: 1, severity: 'HIGH' });

    const verified = await f.service.recordVerifierReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
      decision: 'VERIFIED',
      rationale: 'Independent read-only evidence reproduces the trust-boundary condition.',
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L100-L120'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    expect(verified.verifications).toHaveLength(1);
    expect(verified.verifications[0]!.verifierWorkerId).not.toBe(hunted.findings[0]!.hunterWorkerId);

    const proofed = await f.service.evaluateProofGate({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
    });
    expect(proofed.findings[0]?.state).toBe('VERIFIED');
    expect(proofed.proofGateResults[0]).toMatchObject({
      decision: 'VERIFIED',
      missingRequirements: [],
    });
    expect(proofed.proofGateResults[0]?.satisfiedRequirements).toEqual(expect.arrayContaining([
      'HUNTER_RESULT_SUCCEEDED',
      'HUNTER_RESULT_READ_ONLY',
      'HUNTER_EVIDENCE_PRESENT',
      'INDEPENDENT_VERIFIER',
      'VERIFIER_RESULT_READ_ONLY',
      'VERIFIER_EVIDENCE_PRESENT',
    ]));

    const finalized = await f.service.finalizeRun({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
    });
    expect(finalized.run.state).toBe('COMPLETED');
    expect(finalized.decisionPackage).toMatchObject({ coverageTargetCount: 1, findingCount: 1 });
    expect(finalized.decisionPackage?.verifiedFindingIds).toEqual([hunted.findings[0]!.id]);
    expect((await f.multiWorker.getRun(finalized.run.orchestrationRunId)).run.state).toBe('SUCCEEDED');
  });

  it('deduplicates canonical candidate findings server-side and promotes severity/evidence', async () => {
    const f = await fixture();
    const created = await createRun(f);
    const report = await f.service.recordHunterReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: created.run.id,
      coverageTargetId: created.coverageTargets[0]!.id,
      coverageStatus: 'COVERED',
      summary: 'Duplicate candidates observed from two evidence paths.',
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L80-L99'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
      findings: [
        candidate({ severity: 'MEDIUM', evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L100-L110'] }),
        candidate({ severity: 'CRITICAL', evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L111-L120'] }),
      ],
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ occurrences: 2, severity: 'CRITICAL' });
    expect(report.findings[0]?.evidenceRefs).toEqual(['file:apps/runtime/src/capability-service.ts#L100-L110', 'file:apps/runtime/src/capability-service.ts#L111-L120']);
    expect(report.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not verify on model agreement alone when verifier evidence is missing', async () => {
    const f = await fixture();
    const hunted = await hunterWithFinding(f);
    await f.service.recordVerifierReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
      decision: 'VERIFIED',
      rationale: 'Verifier agrees but supplies no durable evidence.',
      evidenceRefs: [],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    const proofed = await f.service.evaluateProofGate({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
    });
    expect(proofed.findings[0]?.state).toBe('NEEDS_MORE_EVIDENCE');
    expect(proofed.proofGateResults[0]?.missingRequirements).toContain('VERIFIER_EVIDENCE_PRESENT');
  });

  it('requires finding-specific Hunter evidence instead of allowing coverage evidence to substitute', async () => {
    const f = await fixture();
    const created = await createRun(f);
    const hunted = await f.service.recordHunterReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: created.run.id,
      coverageTargetId: created.coverageTargets[0]!.id,
      coverageStatus: 'COVERED',
      summary: 'Coverage has evidence but the finding does not.',
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L80-L99'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
      findings: [candidate({ evidenceRefs: [] })],
    });
    await f.service.recordVerifierReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
      decision: 'VERIFIED',
      rationale: 'Verifier has independent source evidence.',
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L100-L120'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    const proofed = await f.service.evaluateProofGate({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
    });
    expect(proofed.findings[0]?.state).toBe('NEEDS_MORE_EVIDENCE');
    expect(proofed.proofGateResults[0]?.missingRequirements).toContain('HUNTER_EVIDENCE_PRESENT');
  });

  it('revalidates source evidence at Proof Gate and refuses stale file evidence', async () => {
    const f = await fixture();
    const hunted = await hunterWithFinding(f);
    await f.service.recordVerifierReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
      decision: 'VERIFIED',
      rationale: 'Verifier reproduced the candidate before source evidence changed.',
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L100-L120'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    await writeFile(
      path.join(f.workspace.physicalRoot, 'apps/runtime/src/capability-service.ts'),
      Array.from({ length: 220 }, (_, index) => `changed line ${index + 1}\n`).join(''),
      'utf8',
    );

    const proofed = await f.service.evaluateProofGate({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
    });
    expect(proofed.findings[0]?.state).toBe('NEEDS_MORE_EVIDENCE');
    expect(proofed.proofGateResults[0]?.missingRequirements).toEqual(expect.arrayContaining([
      'HUNTER_EVIDENCE_PRESENT',
      'VERIFIER_EVIDENCE_PRESENT',
    ]));
  });

  it('records an evidence-backed verifier rejection as REJECTED rather than VERIFIED', async () => {
    const f = await fixture();
    const hunted = await hunterWithFinding(f);
    await f.service.recordVerifierReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
      decision: 'REJECTED',
      rationale: 'Independent evidence disproves the candidate precondition.',
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L121-L140'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    const proofed = await f.service.evaluateProofGate({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
    });
    expect(proofed.findings[0]?.state).toBe('REJECTED');
  });

  it('continues after mission session rebind by atomically rebinding only the read-only Multi-Worker run', async () => {
    const f = await fixture();
    const hunted = await hunterWithFinding(f);
    const nextSession = f.state.createSession(f.session.clientId, f.session.agentId, 'other');
    await f.state.setSessionCurrentProject(nextSession.id, nextSession.clientId, f.project.id);
    await f.state.rebindMissionSession({
      missionId: f.mission.id,
      clientId: nextSession.clientId,
      sessionId: nextSession.id,
      projectId: f.project.id,
      expectedBindingRevision: 1,
      reason: 'Continue security audit in a new ChatGPT session',
      principal: 'tunnel-service',
    });

    const continued = await f.service.recordVerifierReport({
      clientId: nextSession.clientId,
      sessionId: nextSession.id,
      projectId: f.project.id,
      auditRunId: hunted.run.id,
      findingId: hunted.findings[0]!.id,
      decision: 'VERIFIED',
      rationale: 'Verifier resumed after mission rebind.',
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L141-L160'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    const mw = await f.multiWorker.getRun(continued.run.orchestrationRunId);
    expect(mw.run.sessionId).toBe(nextSession.id);
    expect(mw.tasks.every((task) => task.authority.sessionId === nextSession.id)).toBe(true);
    expect(mw.tasks.every((task) => task.authority.mutablePaths.length === 0)).toBe(true);
  });

  it('blocks mission completion while an audit is active and releases the guard after cancellation', async () => {
    const f = await fixture();
    const created = await createRun(f);
    await expect(f.service.assertMissionAuditsFinalized(f.mission.id)).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    const cancelled = await f.service.cancelRun({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: created.run.id,
    });
    expect(cancelled.run.state).toBe('CANCELLED');
    await expect(f.service.assertMissionAuditsFinalized(f.mission.id)).resolves.toBeUndefined();
  });

  it('recovers an audit as CANCELLED when its durable Multi-Worker run was cancelled', async () => {
    const f = await fixture();
    const created = await createRun(f);
    const mw = await f.multiWorker.getRun(created.run.orchestrationRunId);
    await f.multiWorker.cancelRun({ expectedGeneration: mw.generation, orchestrationRunId: mw.run.id });
    await f.service.recover();
    expect((await f.service.getRun(created.run.id)).run.state).toBe('CANCELLED');
  });

  it('compares completed runs by verified finding fingerprint', async () => {
    const f = await fixture();
    const baselineHunted = await hunterWithFinding(f);
    await f.service.recordVerifierReport({
      clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id,
      auditRunId: baselineHunted.run.id, findingId: baselineHunted.findings[0]!.id,
      decision: 'VERIFIED', rationale: 'Baseline verification', evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L161-L180'], filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    await f.service.evaluateProofGate({
      clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id,
      auditRunId: baselineHunted.run.id, findingId: baselineHunted.findings[0]!.id,
    });
    const baseline = await f.service.finalizeRun({
      clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id, auditRunId: baselineHunted.run.id,
    });

    const mission2 = await f.state.createMission(f.session.clientId, f.session.id, 'Security audit rerun', 'CHATGPT');
    const rerun = await f.service.createRun({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      missionId: mission2.id,
      baselineRunId: baseline.run.id,
      coverageTargets: [{ key: 'trust-boundary', title: 'Trust boundary rerun', scope: 'Repeat the same trust-boundary coverage.' }],
    });
    const target = rerun.coverageTargets[0]!;
    const rerunHunted = await f.service.recordHunterReport({
      clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id,
      auditRunId: rerun.run.id, coverageTargetId: target.id, coverageStatus: 'COVERED',
      summary: 'Rerun hunter report', evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L201-L220'], filesRead: ['apps/runtime/src/capability-service.ts'],
      findings: [candidate()],
    });
    await f.service.recordVerifierReport({
      clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id,
      auditRunId: rerun.run.id, findingId: rerunHunted.findings[0]!.id,
      decision: 'VERIFIED', rationale: 'Rerun verification', evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L181-L200'], filesRead: ['apps/runtime/src/capability-service.ts'],
    });
    await f.service.evaluateProofGate({
      clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id,
      auditRunId: rerun.run.id, findingId: rerunHunted.findings[0]!.id,
    });
    const finalRerun = await f.service.finalizeRun({
      clientId: f.session.clientId, sessionId: f.session.id, projectId: f.project.id, auditRunId: rerun.run.id,
    });
    expect(finalRerun.comparison?.persistentVerifiedFingerprints).toHaveLength(1);
    expect(finalRerun.comparison?.newVerifiedFingerprints).toEqual([]);
    expect(finalRerun.comparison?.resolvedVerifiedFingerprints).toEqual([]);
  });

  it('rejects malformed evidence and file evidence that is not bound to filesRead', async () => {
    const f = await fixture();
    const created = await createRun(f);
    const common = {
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: created.run.id,
      coverageTargetId: created.coverageTargets[0]!.id,
      coverageStatus: 'COVERED' as const,
      summary: 'Adversarial evidence report',
      findings: [],
    };
    await expect(f.service.recordHunterReport({
      ...common,
      evidenceRefs: ['evidence:not-durable'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(f.service.recordHunterReport({
      ...common,
      evidenceRefs: ['file:apps/runtime/src/state.ts#L1-L10'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    })).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    await expect(f.service.recordHunterReport({
      ...common,
      evidenceRefs: ['file:apps/runtime/src/state.ts#L1-L10'],
      filesRead: ['apps/runtime/src/state.ts'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(f.service.recordHunterReport({
      ...common,
      evidenceRefs: ['file:apps/runtime/src/capability-service.ts#L999-L1000'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(f.service.recordHunterReport({
      ...common,
      evidenceRefs: ['file:apps//runtime/src/capability-service.ts#L1-L2'],
      filesRead: ['apps/runtime/src/capability-service.ts'],
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('rejects artifact evidence whose bytes no longer match the registered hash', async () => {
    const f = await fixture();
    const created = await createRun(f);
    const filename = path.join(f.workspace.physicalRoot, 'security-evidence.txt');
    const original = 'security evidence v1\n';
    await writeFile(filename, original, 'utf8');
    const artifact = await f.resources.registerArtifact({
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      physicalPath: filename,
      mime: 'text/plain',
      artifactType: 'security-audit-evidence',
      size: Buffer.byteLength(original, 'utf8'),
      sha256: createHash('sha256').update(original).digest('hex'),
      sensitivity: 'INTERNAL',
      retentionPolicy: 'MISSION',
    });
    await writeFile(filename, 'tampered security evidence\n', 'utf8');

    await expect(f.service.recordHunterReport({
      clientId: f.session.clientId,
      sessionId: f.session.id,
      projectId: f.project.id,
      auditRunId: created.run.id,
      coverageTargetId: created.coverageTargets[0]!.id,
      coverageStatus: 'COVERED',
      summary: 'Artifact integrity adversarial report',
      evidenceRefs: [`artifact:${artifact.artifactId}`],
      filesRead: [],
      findings: [],
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('uses project-bound Direct Context for security_audit calls without an explicit sessionId', async () => {
    const f = await fixture();
    const request = new Request('http://127.0.0.1/mcp', { headers: { 'x-iris-client-id': f.session.clientId } });
    const created = await executeSecurityAuditTool({
      operation: 'create_run',
      projectId: f.project.id,
      workspaceId: f.workspace.workspaceId,
      missionId: f.mission.id,
      coverageTargets: [{ key: 'direct-context', title: 'Direct Context', scope: 'Verify tunnel project-bound context.' }],
    }, request, f.state, f.service, 'tunnel-service') as Awaited<ReturnType<SecurityAuditService['createRun']>>;
    expect(created.run.projectId).toBe(f.project.id);
    expect(created.run.sessionId).toBe(f.session.id);
  });
});
