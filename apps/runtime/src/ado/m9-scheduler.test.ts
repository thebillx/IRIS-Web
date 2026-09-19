import { describe, expect, it } from 'vitest';
import { planDueScheduledSyncs } from './m9-scheduler.js';
import type { ScheduleIntent } from './m6/sync.js';

const scope = { organizationId:'org',projectId:'project',teamId:'team',boardId:'board' };
const due: ScheduleIntent = { scheduleId:'daily-board',scope,mode:'INCREMENTAL',nextDueAt:'2026-09-20T00:00:00.000Z',enabled:true };
const future: ScheduleIntent = { scheduleId:'future-board',scope,mode:'FULL',nextDueAt:'2026-09-21T00:00:00.000Z',enabled:true };
const inventory = { snapshotId:'snapshot-1',complete:true,items:[{itemId:1,parentId:null,backlogIds:['Stories']}] };
const policy = { gateVersion:'m5-v1',minimumPromoted:0,allowRejections:true };

describe('M9 scheduled Board sync planning', () => {
  it('converts only due enabled schedules into existing SyncCoordinator start contracts', () => {
    const planned = planDueScheduledSyncs([future,due], {'daily-board':inventory}, {'daily-board':policy}, '2026-09-20T01:00:00.000Z');
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      scheduleId:'daily-board', start:{ mode:'INCREMENTAL',trigger:{kind:'SCHEDULE',scheduleId:'daily-board'},at:'2026-09-20T01:00:00.000Z' },
    });
  });
  it('does not schedule disabled entries', () => {
    expect(planDueScheduledSyncs([{...due,enabled:false}], {}, {}, '2026-09-20T01:00:00.000Z')).toEqual([]);
  });
  it('fails closed if a due schedule is missing its inventory or policy snapshot', () => {
    expect(() => planDueScheduledSyncs([due], {}, {}, '2026-09-20T01:00:00.000Z')).toThrow('SCHEDULE_INPUT_MISSING');
  });
  it('rejects duplicate schedule identities', () => {
    expect(() => planDueScheduledSyncs([due,due], {'daily-board':inventory}, {'daily-board':policy}, '2026-09-20T01:00:00.000Z'))
      .toThrow('SCHEDULE_ID_CONFLICT');
  });
});
