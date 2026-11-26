import { randomUUID } from 'node:crypto';
import type { WorkManagementActor, WorkManagementRequest } from '@cindy/maker-shared/work-management';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState';
import type { DataOwnerPushStamp } from '../../shared/dataOwnerPush';
import { activeSelfHostedRelay } from '../device-link/selfHostedRelayRouting';
import { getDbClient, tryGetDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';

import { configureWorkSyncNotification, wakeWorkSync } from './sync';

const log = createLogger('work-management');

configureWorkSyncNotification(() => changed?.(getActiveDataOwnerPushStamp()));
let changed: ((owner: DataOwnerPushStamp) => void) | undefined;
export function setWorkManagementChangeListener(listener: (owner: DataOwnerPushStamp) => void): void { changed = listener; }
export function isWorkManagementAvailable(): boolean {
  return !!activeOwnerScopeKey() && !isAppSessionBoundaryPending() && !!tryGetDbClient() && activeSelfHostedRelay()?.authMode === 'none';
}

/** Both human UI and Agent tools use the same Profile DB and transaction. */
export async function executeWorkManagementRequest(actor: WorkManagementActor, request: WorkManagementRequest): Promise<Record<string, unknown>> {
  const db = getDbClient(), owner = activeOwnerScopeKey(), route = activeSelfHostedRelay(), stamp = getActiveDataOwnerPushStamp();
  const current = () => {
    if (!owner || isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey() || db !== tryGetDbClient()
      || route?.authMode !== 'none' || activeSelfHostedRelay()?.authMode !== 'none'
      || route.baseUrl !== activeSelfHostedRelay()?.baseUrl || route.relayId !== activeSelfHostedRelay()?.relayId)
      throw new Error('WORK_CONTEXT_CHANGED');
  };
  current();
  try {
    const result = await db.tx('umedaWork.execute', { request, actor, created_id: randomUUID(), now: Date.now() });
    current();
    if (request.operation === 'create' || request.operation === 'update' || request.operation === 'sync_resolve') {
      wakeWorkSync();
      try { changed?.(stamp); } catch { log.warn('work management invalidation was not delivered'); }
    }
    return result;
  } catch (error) {
    current();
    const message = error instanceof Error ? error.message : '';
    const codes = ['WORK_INVALID_INPUT', 'WORK_NOT_FOUND', 'WORK_VERSION_CONFLICT', 'WORK_REQUEST_REUSED', 'WORK_INVALID_RELATION', 'WORK_CONTEXT_CHANGED', 'WORK_DATA_UNREADABLE', 'WORK_SYNC_LOCAL_ONLY_DRAFT', 'WORK_SYNC_RESOLUTION_TOO_LARGE'];
    const code = codes.find(candidate => message === candidate || message.endsWith(`: ${candidate}`));
    if (!code) throw error;
    return { ok: false, errorCode: code, hint: code === 'WORK_VERSION_CONFLICT'
      ? '记录已有新版本，本次整批未保存。请读取相关对象、合并后使用新的 request_id。'
      : code === 'WORK_REQUEST_REUSED' ? 'request_id 已用于不同内容；不要把修改后的内容当成原请求重试。'
        : '本次操作未保存，请检查对象、关系或当前执行任务。旧记录保持不变。' };
  }
}
