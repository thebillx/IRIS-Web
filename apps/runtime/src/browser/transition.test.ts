import { describe, expect, it } from 'vitest';
import {
  BrowserContractError,
  transitionBrowserAdapter,
  type BrowserSessionScope,
} from './contract.js';

const session: BrowserSessionScope = {
  sessionId: 'browser-session-1',
  projectId: 'project-p7',
  browserBindingId: 'browser-binding-1',
  adapter: 'dom',
  uploadArtifactIds: ['artifact-1', 'artifact-2'],
};

function code(fn: () => unknown): string {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof BrowserContractError ? error.code : String(error);
  }
}

describe('AC-BROWSER-001 browser adapter transition audit', () => {
  it('records an explicit DOM -> native fallback without widening project/upload scope', () => {
    const result = transitionBrowserAdapter(session, {
      transitionId: 'transition-1',
      sessionId: session.sessionId,
      projectId: session.projectId,
      browserBindingId: session.browserBindingId,
      from: 'dom',
      to: 'native',
      reason: 'DOM surface unavailable; use bounded native adapter.',
      uploadArtifactIds: ['artifact-1'],
    });
    expect(result.session.adapter).toBe('native');
    expect(result.session.projectId).toBe(session.projectId);
    expect(result.session.uploadArtifactIds).toEqual(['artifact-1']);
    expect(result.audit).toMatchObject({
      transitionId: 'transition-1',
      from: 'dom',
      to: 'native',
      projectId: session.projectId,
      browserBindingId: session.browserBindingId,
    });
    expect(Object.isFrozen(result.audit)).toBe(true);
  });

  it('rejects implicit or no-op adapter transitions', () => {
    expect(code(() => transitionBrowserAdapter(session, {
      transitionId: 'transition-2',
      sessionId: session.sessionId,
      projectId: session.projectId,
      browserBindingId: session.browserBindingId,
      from: 'native',
      to: 'dom',
      reason: 'wrong current adapter',
      uploadArtifactIds: [],
    }))).toBe('ADAPTER_TRANSITION_DENIED');

    expect(code(() => transitionBrowserAdapter(session, {
      transitionId: 'transition-3',
      sessionId: session.sessionId,
      projectId: session.projectId,
      browserBindingId: session.browserBindingId,
      from: 'dom',
      to: 'dom',
      reason: 'no-op',
      uploadArtifactIds: [],
    }))).toBe('ADAPTER_TRANSITION_DENIED');
  });

  it('rejects project, binding, session or upload scope widening', () => {
    for (const patch of [
      { projectId: 'other-project' },
      { browserBindingId: 'other-binding' },
      { sessionId: 'other-session' },
    ]) {
      expect(code(() => transitionBrowserAdapter(session, {
        transitionId: 'transition-scope',
        sessionId: session.sessionId,
        projectId: session.projectId,
        browserBindingId: session.browserBindingId,
        from: 'dom',
        to: 'native',
        reason: 'fallback',
        uploadArtifactIds: ['artifact-1'],
        ...patch,
      }))).toBe('SCOPE_WIDENING');
    }

    expect(code(() => transitionBrowserAdapter(session, {
      transitionId: 'transition-upload',
      sessionId: session.sessionId,
      projectId: session.projectId,
      browserBindingId: session.browserBindingId,
      from: 'dom',
      to: 'native',
      reason: 'fallback',
      uploadArtifactIds: ['artifact-1', 'artifact-new'],
    }))).toBe('SCOPE_WIDENING');
  });
});
