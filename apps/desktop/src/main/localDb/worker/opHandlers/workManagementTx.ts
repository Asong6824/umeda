import type Database from 'better-sqlite3';
import type { WorkManagementTransaction } from '@cindy/maker-shared/work-management';
import { runWorkReplica } from '@cindy/maker-shared/work-replication';
import { runWorkStore } from '@cindy/maker-shared/work-store';

/** Session fencing belongs to the execution host; shared business storage has no Agent runtime. */
export function runWorkManagementTransaction(db: Database.Database, input: WorkManagementTransaction, execute = runWorkStore, replicate = runWorkReplica): Record<string, unknown> {
  return db.transaction(() => {
    const request = input.request;
    let result: Record<string, unknown>;
    if (request.operation === 'sync_status') result = replicate(db, { operation: 'status' });
    else if (request.operation === 'sync_conflict' || request.operation === 'sync_resolve') {
      if (typeof request.request_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(request.request_id)
        || (request.operation === 'sync_resolve' && !['local', 'remote'].includes(request.choice))) throw new Error('WORK_INVALID_INPUT');
      result = request.operation === 'sync_conflict' ? replicate(db, { operation: 'conflict', request_id: request.request_id })
        : replicate(db, { operation: 'resolve', request_id: request.request_id, choice: request.choice, nonce: input.created_id, now: input.now, actor: input.actor }, execute);
    } else result = execute(db, input);
    if (input.actor.kind !== 'user') {
      const row = db.prepare('SELECT status,cleared_at FROM sessions WHERE id=?').get(input.actor.session_id) as { status: string; cleared_at: number | null } | undefined;
      if (!row || row.status === 'deleted' || (row.cleared_at ?? 0) !== input.actor.epoch) throw new Error('WORK_CONTEXT_CHANGED');
    }
    if (input.request.operation === 'create' || input.request.operation === 'update') replicate(db, { operation: 'capture', input });
    return result;
  })();
}
