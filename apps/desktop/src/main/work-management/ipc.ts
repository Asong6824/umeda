import { randomUUID } from 'node:crypto';
import { WORK_SYNC_STATUS_CHANNEL, WORK_SYNC_RESOLVE_CHANNEL, WORK_SYNC_CONFLICT_CHANNEL } from '@cindy/maker-shared/work-management';
import { getDbClient } from '../localDb/client/current';
import { wakeWorkSync } from './sync';
import { BrowserWindow, ipcMain } from 'electron';
import { WORK_MANAGEMENT_AVAILABLE, WORK_MANAGEMENT_CHANNEL, WORK_MANAGEMENT_CHANGED, type WorkManagementRequest } from '@cindy/maker-shared/work-management';
import { getActiveDataOwnerPushStamp } from '../appSessionState';
import { isDataOwnerPushStamp } from '../../shared/dataOwnerPush';
import { assertTrustedAppRendererEvent, isTrustedAppRendererWindow } from '../security/trustedAppRenderer';
import { throwIpcError } from '../utils/ipcValidate';
import { createLogger } from '../logger';
import { isIpcError } from '../../shared/ipc-errors';
import { executeWorkManagementRequest, isWorkManagementAvailable, setWorkManagementChangeListener } from './service';

const log = createLogger('work-management');
export function registerWorkManagementIpc(): void {
  const assertOwner = (value: unknown) => {
    const current = getActiveDataOwnerPushStamp();
    if (!isDataOwnerPushStamp(value) || value.dataOwnerId !== current.dataOwnerId || value.ownerGeneration !== current.ownerGeneration)
      throwIpcError('PRECONDITION_FAILED', 'Work data owner changed');
  };
  ipcMain.handle(WORK_MANAGEMENT_AVAILABLE, (event, owner) => {
    assertTrustedAppRendererEvent(event); assertOwner(owner);
    return isWorkManagementAvailable();
  });
  ipcMain.handle(WORK_MANAGEMENT_CHANNEL, async (event, request: WorkManagementRequest, owner: unknown) => {
    assertTrustedAppRendererEvent(event); assertOwner(owner);
    if (!isWorkManagementAvailable()) throwIpcError('PRECONDITION_FAILED', 'Work management unavailable');
    let result: Record<string, unknown>;
    try { result = await executeWorkManagementRequest({ kind: 'user' }, request); }
    catch (error) {
      if (isIpcError(error)) throw error;
      throwIpcError('INTERNAL', 'Work management request could not be confirmed');
    }
    assertOwner(owner);
    if (result.ok === false) {
      if (result.errorCode === 'WORK_VERSION_CONFLICT') throwIpcError('WORK_VERSION_CONFLICT', 'The work item has changed');
      if (result.errorCode === 'WORK_REQUEST_REUSED') throwIpcError('WORK_REQUEST_REUSED', 'The request ID has different content');
      if (result.errorCode === 'WORK_INVALID_RELATION') throwIpcError('WORK_INVALID_RELATION', 'Invalid work relationship');
      const code = result.errorCode === 'WORK_NOT_FOUND' ? 'NOT_FOUND' : result.errorCode === 'WORK_INVALID_INPUT' ? 'INVALID_PARAMS' : 'PRECONDITION_FAILED';
      throwIpcError(code, String(result.errorCode));
    }
    return { ...result, ok: true };
  });
  ipcMain.handle(WORK_SYNC_STATUS_CHANNEL, async (event, owner) => {
    assertTrustedAppRendererEvent(event); assertOwner(owner);
    const result = await getDbClient().tx('umedaWork.replica', { operation: 'status' });
    assertOwner(owner); return result;
  });
  ipcMain.handle(WORK_SYNC_CONFLICT_CHANNEL, async (event, requestId: string, owner) => {
    assertTrustedAppRendererEvent(event); assertOwner(owner);
    if (typeof requestId !== 'string' || requestId.length > 128) throwIpcError('INVALID_PARAMS', 'Invalid conflict');
    const result = await getDbClient().tx('umedaWork.replica', { operation: 'conflict', request_id: requestId });
    assertOwner(owner); return result;
  });
  ipcMain.handle(WORK_SYNC_RESOLVE_CHANNEL, async (event, requestId: string, choice: 'local' | 'remote', owner) => {
    assertTrustedAppRendererEvent(event); assertOwner(owner);
    if (typeof requestId !== 'string' || requestId.length > 128 || !['local', 'remote'].includes(choice)) throwIpcError('INVALID_PARAMS', 'Invalid conflict resolution');
    await getDbClient().tx('umedaWork.replica', { operation: 'resolve', request_id: requestId, choice, nonce: randomUUID(), now: Date.now() });
    assertOwner(owner); wakeWorkSync();
    for (const window of BrowserWindow.getAllWindows()) if (isTrustedAppRendererWindow(window)) window.webContents.send(WORK_MANAGEMENT_CHANGED, owner);
  });
  setWorkManagementChangeListener(owner => {
    for (const window of BrowserWindow.getAllWindows()) {
      try { if (isTrustedAppRendererWindow(window)) window.webContents.send(WORK_MANAGEMENT_CHANGED, owner); }
      catch { log.warn('work management invalidation could not reach a renderer'); }
    }
  });
}
