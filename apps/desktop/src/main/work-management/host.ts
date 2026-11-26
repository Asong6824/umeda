import type { WorkManagementCallback } from '@cindy/mcps';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState';
import { getDbClient, tryGetDbClient } from '../localDb/client/current';
import { executeWorkManagementRequest } from './service';

/** Shared business data, independent of current Session lifecycle. No automatic context loading. */
export const executeWorkManagement: WorkManagementCallback = async (context, request) => {
  if (!context.sessionId) return { ok: false, errorCode: 'WORK_CONTEXT_CHANGED' };
  const db = getDbClient(), owner = activeOwnerScopeKey();
  const row = await db.queryOne<{ cleared_at: number | null }>('SELECT cleared_at FROM sessions WHERE id=? AND status<>?', [context.sessionId, 'deleted']);
  if (!row || isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey() || db !== tryGetDbClient())
    return { ok: false, errorCode: 'WORK_CONTEXT_CHANGED' };
  return executeWorkManagementRequest({ kind: 'agent_report', session_id: context.sessionId, epoch: row.cleared_at ?? 0, agent_kind: context.agentKind }, request);
};
