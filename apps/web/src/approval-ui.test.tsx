import { readFile } from 'node:fs/promises';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ApprovalReview, isAppliedOwnerDenial, type PendingApproval } from './App.js';

const longUnbroken = 'x'.repeat(16_384);
const approval: PendingApproval = {
  id: 'approval-test',
  timestamp: '2026-09-04T00:00:00.000Z',
  clientId: 'client-a',
  sessionId: 'session-a',
  agentId: 'implementer-a',
  capabilityId: 'file.write',
  riskClass: 'MODERATE',
  projectId: 'project-a',
  target: '/Users/bill/iris/fixture/very-long-target.txt',
  decision: 'OWNER_REQUIRED',
  reason: 'ASK_EVERY_TIME requires owner approval',
  exactAction: `file.write target=/Users/bill/iris/fixture/very-long-target.txt argument=${longUnbroken}`,
  canAlwaysAllowProject: true,
};

describe('Web approval review surface', () => {
  it('keeps all security-relevant exact-action text and exposes native keyboard-operable buttons', () => {
    const markup = renderToStaticMarkup(createElement(ApprovalReview, {
      approval,
      onCancel: () => undefined,
      onDecision: () => undefined,
    }));
    expect(markup).toContain('class="approval-dialog"');
    expect(markup).toContain('class="approval-body"');
    expect(markup).toContain('class="approval-footer"');
    expect(markup).toContain(longUnbroken);
    expect(markup).toContain('Allow once');
    expect(markup).toContain('Always allow matching project policy');
    expect(markup).toContain('Deny');
    expect(markup).toContain('Cancel');
    expect(markup).not.toContain('disabled');
  });

  it('treats only an explicit capability-denied approval response as a successfully applied owner denial', async () => {
    await expect(isAppliedOwnerDenial(new Response(JSON.stringify({ error: { code: 'CAPABILITY_DENIED' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }))).resolves.toBe(true);
    await expect(isAppliedOwnerDenial(new Response(JSON.stringify({ error: { code: 'CONTROL_DENIED' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    }))).resolves.toBe(false);
    await expect(isAppliedOwnerDenial(new Response('{}', { status: 200 }))).resolves.toBe(false);
  });

  it('CSS bounds the dialog to the dynamic viewport and scrolls only the details body', async () => {
    const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.approval-dialog\s*\{[\s\S]*max-height:\s*calc\(100dvh/);
    expect(css).toMatch(/\.approval-surface\s*\{[\s\S]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.approval-body\s*\{[\s\S]*overflow:\s*auto/);
    expect(css).toMatch(/\.approval-footer\s*\{[\s\S]*pointer-events:\s*auto/);
    expect(css).toMatch(/\.exact-action\s*\{[\s\S]*white-space:\s*pre-wrap[\s\S]*overflow-wrap:\s*anywhere/);
  });

  it('uses normal Web chrome rather than Electron drag/title-bar regions', async () => {
    const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
    expect(css).not.toContain('-webkit-app-region');
    expect(css).not.toContain('titleBarOverlay');
    expect(css).toMatch(/\.brand-mark\s*\{[\s\S]*pointer-events:\s*none/);
  });
});
