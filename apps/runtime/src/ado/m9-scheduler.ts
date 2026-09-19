import type { Inventory, PublicationPolicy } from './m6/model.js';
import type { ScheduleIntent, StartSync } from './m6/sync.js';

export interface DueSchedule {
  readonly scheduleId: string;
  readonly start: StartSync;
}

export function planDueScheduledSyncs(
  intentsInput: readonly ScheduleIntent[],
  inventories: Readonly<Record<string, Inventory>>,
  policies: Readonly<Record<string, PublicationPolicy>>,
  now: string,
): readonly DueSchedule[] {
  if (!timestamp(now) || !Array.isArray(intentsInput) || intentsInput.length > 1000) throw new Error('INVALID_SCHEDULE_INPUT');
  const seen = new Set<string>();
  const due: DueSchedule[] = [];
  for (const intent of intentsInput) {
    validateIntent(intent);
    if (seen.has(intent.scheduleId)) throw new Error('SCHEDULE_ID_CONFLICT');
    seen.add(intent.scheduleId);
    if (!intent.enabled || intent.nextDueAt > now) continue;
    const inventory = inventories[intent.scheduleId];
    const policy = policies[intent.scheduleId];
    if (inventory === undefined || policy === undefined) throw new Error('SCHEDULE_INPUT_MISSING');
    const syncRunId = 'schedule:' + intent.scheduleId + ':' + now.replace(/[-:.TZ]/g, '').slice(0, 14);
    const start: StartSync = {
      syncRunId,
      scope: structuredClone(intent.scope),
      mode: intent.mode,
      trigger: { kind: 'SCHEDULE', scheduleId: intent.scheduleId },
      inventory: structuredClone(inventory),
      policy: structuredClone(policy),
      at: now,
    };
    due.push(Object.freeze({ scheduleId: intent.scheduleId, start: Object.freeze(start) }));
  }
  return Object.freeze(due.sort((a,b)=>a.scheduleId.localeCompare(b.scheduleId)));
}

function validateIntent(intent: ScheduleIntent): void {
  if (!bounded(intent.scheduleId) || !timestamp(intent.nextDueAt) || typeof intent.enabled !== 'boolean'
    || !['FULL','INCREMENTAL'].includes(intent.mode)
    || !bounded(intent.scope.organizationId) || !bounded(intent.scope.projectId)
    || !bounded(intent.scope.teamId) || !bounded(intent.scope.boardId)) throw new Error('INVALID_SCHEDULE_INTENT');
}
const bounded = (value: string) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
