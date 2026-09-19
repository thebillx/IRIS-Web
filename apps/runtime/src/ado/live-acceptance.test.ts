import { mkdtempSync, realpathSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  persistAdoLiveAcceptance,
  runAdoLiveReadAcceptance,
  type AdoLiveAcceptanceTarget,
} from './live-acceptance.js';

const target: AdoLiveAcceptanceTarget = {
  organization: 'example-org',
  project: 'Example Project',
  teamName: 'Example Team',
  epicBoardName: 'Epics',
  requirementBacklogName: 'Stories',
  level1WorkItemId: 100,
  storyWorkItemId: 201,
};

const pat = 'synthetic-pat-1234567890-ABCDEFGHIJ';

function workItem(id: number) {
  const relation = (rel: string, targetId: number) => ({
    rel,
    url: 'https://dev.azure.com/example-org/p1/_apis/wit/workItems/' + targetId,
  });
  const base = {
    id,
    rev: 3,
    fields: {
      'System.WorkItemType': id === 100 ? 'Epic' : id === 200 ? 'Feature' : 'User Story',
      'System.Title': 'Item ' + id,
      'System.State': 'Active',
      'System.Description': 'Behavior for item ' + id + ' is available to the user.',
      'System.AreaPath': 'Example Project\\Area',
      'System.IterationPath': 'Example Project\\Sprint 1',
      'System.ChangedDate': '2026-09-19T12:00:00.000Z',
    },
    relations: [] as { rel: string; url: string }[],
  };
  if (id === 100) base.relations.push(relation('System.LinkTypes.Hierarchy-Forward', 200));
  if (id === 200) base.relations.push(relation('System.LinkTypes.Hierarchy-Forward', 201));
  if (id === 201) base.relations.push(relation('System.LinkTypes.Hierarchy-Reverse', 200));
  return base;
}

function fakeFetch(options: { changeRevision?: boolean } = {}) {
  const seen: { method: string; authorization: string | null; url: string }[] = [];
  let listReads = 0;
  const implementation: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    seen.push({ method, authorization: headers.get('authorization'), url: url.href });

    const pathname = url.pathname;
    let body: unknown;
    if (pathname.endsWith('/_apis/projects/Example%20Project')) {
      body = { id: 'p1', name: 'Example Project' };
    } else if (pathname.endsWith('/_apis/projects/p1/teams')) {
      body = { count: 1, value: [{ id: 't1', name: 'Example Team' }] };
    } else if (pathname.endsWith('/p1/t1/_apis/work/boards')) {
      body = { count: 2, value: [
        { id: 'b-portfolio', name: 'Epics' },
        { id: 'b-requirements', name: 'Stories' },
      ] };
    } else if (pathname.endsWith('/p1/t1/_apis/work/teamsettings/teamfieldvalues')) {
      body = {
        field: { referenceName: 'System.AreaPath' },
        defaultValue: 'Example Project\\Area',
        values: [{ value: 'Example Project\\Area', includeChildren: true }],
      };
    } else if (pathname.endsWith('/p1/t1/_apis/work/backlogs')) {
      body = {
        count: 2,
        value: [
          { id: 'portfolio', name: 'Epics', rank: 2, type: 'portfolio', isHidden: false, workItemTypes: [{ name: 'Epic' }, { name: 'Feature' }] },
          { id: 'requirements', name: 'Stories', rank: 1, type: 'requirement', isHidden: false, workItemTypes: [{ name: 'User Story' }] },
        ],
      };
    } else if (pathname.endsWith('/p1/t1/_apis/work/backlogs/portfolio/workItems')) {
      body = { workItems: [{ target: { id: 100 } }, { target: { id: 200 } }] };
    } else if (pathname.endsWith('/p1/t1/_apis/work/backlogs/requirements/workItems')) {
      body = { workItems: [{ target: { id: 201 } }] };
    } else if (/\/p1\/_apis\/wit\/workItems\/\d+\/comments$/i.test(pathname)) {
      body = { totalCount: 0, count: 0, comments: [] };
    } else if (/\/p1\/_apis\/wit\/workitems\/\d+$/i.test(pathname)) {
      const id = Number(pathname.split('/').at(-1));
      body = workItem(id);
    } else if (pathname.endsWith('/p1/_apis/wit/workitems')) {
      listReads += 1;
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean).map(Number);
      body = {
        count: ids.length,
        value: ids.map(id => ({
          ...workItem(id),
          rev: options.changeRevision && listReads >= 2 && id === 201 ? 4 : 3,
        })),
      };
    } else {
      return new Response(JSON.stringify({ error: 'not-found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { implementation, seen };
}

describe('ADO live read-only acceptance transport', () => {
  it('executes Levels 1-4 using GET only and never serializes the credential', async () => {
    const fake = fakeFetch();
    const result = await runAdoLiveReadAcceptance(target, pat, { maxItems: 100 }, fake.implementation);
    expect(result.receipt).toMatchObject({
      zeroMutation: true,
      revisionStable: true,
      level1: { itemCount: 1 },
      level2: { itemCount: 2 },
      level3: { itemCount: 1 },
      level4: { itemCount: 3 },
    });
    expect(fake.seen.every(entry => entry.method === 'GET')).toBe(true);
    expect(fake.seen.every(entry => entry.url.startsWith('https://dev.azure.com/example-org/'))).toBe(true);
    expect(fake.seen.every(entry => entry.authorization?.startsWith('Basic ') === true)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(pat);
    expect(result.snapshot.items.map(item => item.id).sort((a, b) => a - b)).toEqual([100, 200, 201]);
    expect(result.snapshot.ledger.every(entry => entry.method === 'GET')).toBe(true);
  });

  it('fails closed when a Work Item revision changes during the acceptance window', async () => {
    const fake = fakeFetch({ changeRevision: true });
    await expect(runAdoLiveReadAcceptance(target, pat, { maxItems: 100 }, fake.implementation))
      .rejects.toMatchObject({ code: 'REVISION_CHANGED' });
  });

  it('persists only private snapshot and receipt files', async () => {
    const fake = fakeFetch();
    const result = await runAdoLiveReadAcceptance(target, pat, { maxItems: 100 }, fake.implementation);
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'iris-ado-live-')));
    try {
      const paths = await persistAdoLiveAcceptance(root, result);
      expect(statSync(path.dirname(paths.snapshotPath)).mode & 0o777).toBe(0o700);
      expect(statSync(paths.snapshotPath).mode & 0o777).toBe(0o600);
      expect(statSync(paths.receiptPath).mode & 0o777).toBe(0o600);
      expect(readFileSync(paths.snapshotPath, 'utf8')).not.toContain(pat);
      expect(readFileSync(paths.receiptPath, 'utf8')).not.toContain(pat);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
