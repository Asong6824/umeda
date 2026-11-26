import { eq } from 'drizzle-orm';
import type { WorkRecordsCallback } from '@cindy/mcps';
import { renderWorkCheckpoint } from '@cindy/maker-shared/work-checkpoint';
import { activeOwnerScopeKey, ownerScopedUserDataPath, isAppSessionBoundaryPending } from '../appSessionState';
import { getDbClient, tryGetDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';
import { activeSelfHostedRelay } from '../device-link/selfHostedRelayRouting';
import { workRecordStore } from './store';
import { observeWorkWorkspace } from './workspace';

async function capture(sessionId: string) {
  const db = getDbClient(), owner = activeOwnerScopeKey();
  const current = () => {
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey() || db !== tryGetDbClient()) throw new Error('WORK_RECORD_SCOPE_CHANGED');
  };
  current();
  const read = async () => {
    const [row] = await db.drizzle.select({ id: sessions.id, status: sessions.status, clearedAt: sessions.clearedAt,
      workingDir: sessions.workingDir, remoteHostId: sessions.remoteHostId, agentDeviceId: sessions.agentDeviceId }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    current();
    if (!row || row.status === 'deleted') throw new Error('WORK_RECORD_TASK_UNAVAILABLE');
    return row;
  };
  const facts = await read();
  const assertSession = async () => { if ((await read()).clearedAt !== facts.clearedAt) throw new Error('WORK_RECORD_SCOPE_CHANGED'); };
  const store = workRecordStore(ownerScopedUserDataPath('work-records'), sessionId, facts.clearedAt ?? 0, current);
  return { facts, store, assertSession };
}

/** Caller access is checked by the existing helper host boundary; never accepts another task ID. */
export const executeWorkRecords: WorkRecordsCallback = async (context, request) => {
  if (!context.sessionId || activeSelfHostedRelay()?.authMode !== 'none') return { ok: false, errorCode: 'WORK_RECORD_UNAVAILABLE' };
  const { facts, store, assertSession } = await capture(context.sessionId);
  try {
    let result: Record<string, unknown>;
    if (request.operation === 'save') {
      const workspace = await observeWorkWorkspace(facts);
      await assertSession();
      const record = await store.save(request.expected_revision, request.checkpoint, { kind: 'agent_report', agentKind: context.agentKind,
        ...(context.sessionInstanceId ? { sessionInstanceId: context.sessionInstanceId } : {}) }, workspace);
      result = { revision: record.revision, record, status: 'local_saved', sync_status: 'not_configured' };
    } else if (request.operation === 'get') {
      const record = request.revision === undefined ? await store.latest() : await store.at(request.revision);
      result = { revision: record?.revision ?? 0, record };
    } else {
      const page = await store.list(request.before, request.limit);
      result = { records: page.records.map(record => ({ revision: record.revision, saved_at: record.savedAt, author: record.author,
        objective: record.checkpoint.objective.slice(0, 200), completed_count: record.checkpoint.completed.length,
        pending_count: record.checkpoint.next.length, blocker_count: record.checkpoint.blockers.length })), next_before: page.next_before };
    }
    await assertSession();
    return { scope: 'current_task_local', session_id: facts.id, epoch: facts.clearedAt ?? 0, ...result };
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    if (['WORK_RECORD_CONFLICT', 'WORK_RECORD_NOT_FOUND', 'INVALID_WORK_CHECKPOINT', 'INVALID_WORK_RECORD', 'WORK_RECORD_TOO_LARGE', 'INVALID_WORK_RECORD_REVISION'].includes(code))
      return { ok: false, errorCode: code, hint: code === 'WORK_RECORD_CONFLICT' ? '检查点已有新修订，先读取并合并。' : '工作记录未能通过校验，保留原上下文并检查输入或历史记录。' };
    throw error; // shared tool boundary reports an uncertain save without leaking local paths/errors.
  }
};

/** Called only at the existing safe engine-switch boundary, not on every message. */
export async function readSessionWorkCheckpointHandoff(sessionId: string): Promise<string | null> {
  if (activeSelfHostedRelay()?.authMode !== 'none') return null;
  const { facts, store, assertSession } = await capture(sessionId);
  let note: string | null;
  try {
    const record = await store.latest();
    note = record ? renderWorkCheckpoint(record, await observeWorkWorkspace(facts)) : null;
  } catch {
    note = JSON.stringify({ status: 'checkpoint_unavailable', details: 'Read get_work_checkpoint and original task history; do not assume earlier work is complete.' });
  }
  await assertSession();
  return note;
}
