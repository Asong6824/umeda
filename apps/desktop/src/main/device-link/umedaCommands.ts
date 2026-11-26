import {
  createUmedaCommandConsumer, UMEDA_COMMAND_FEATURE,
  REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_PROTOCOL_VERSION,
  type UmedaCommandClaim, type UmedaCommandRequest,
} from '@cindy/device-link';
import { serverApiFetch } from '../serverApiClient';
import { activeSelfHostedRelay } from './selfHostedRelayRouting';
import { runInvoke, setControllerDisplayName } from './dispatch';
import { setControllerPlatform } from './controllerPlatform';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from './broadcast-tap';
import { createLogger } from '../logger';

const log = createLogger('umeda-inbox');

/** Only enqueue durable inputs through the existing remote permission + owner boundary. */
export async function executeUmedaCommand(command: UmedaCommandClaim, isCurrent: () => boolean = () => true) {
  if (!isCurrent()) return { state: 'retry' as const, errorCode: 'RECEIVER_CHANGED' };
  if (command.sourcePlatform !== undefined) setControllerPlatform(command.sourceDeviceId, command.sourcePlatform);
  if (typeof command.sourceName === 'string') setControllerDisplayName(command.sourceDeviceId, command.sourceName);
  if (command.resourceRef) {
    const resource = await runInvoke(command.sourceDeviceId, { channel: REMOTE_RESOURCE_GET_CHANNEL, args: [{
      client: { protocolVersion: REMOTE_RESOURCE_PROTOCOL_VERSION, primitives: ['status'], locale: command.message.uiLanguage },
      ref: command.resourceRef,
    }] });
    if (!resource.ok) return classifyFailure(resource.error);
    const value = resource.result as { ref?: typeof command.resourceRef;
      blocks?: Array<{ id: string; primitive: string; data?: { stage?: string } }>;
      links?: Array<{ rel: string; target: { kind: string; sessionId?: string } }> };
    const stage = value?.blocks?.find(block => block.id === 'invitation' && block.primitive === 'status')?.data?.stage;
    if (stage && stage !== 'ready') return { state: stage === 'failed' ? 'failed' as const : 'retry' as const, errorCode: 'RESOURCE_PREPARING' };
    if (value?.ref?.collectionId !== command.resourceRef.collectionId || value.ref.kind !== command.resourceRef.kind
      || value.ref.id !== command.resourceRef.id || !value.links?.some(l => l.rel === 'conversation'
        && l.target.kind === 'session' && l.target.sessionId === command.sessionId)) {
      return { state: 'failed' as const, errorCode: 'RESOURCE_CHANGED' };
    }
    if (!isCurrent()) return { state: 'retry' as const, errorCode: 'RECEIVER_CHANGED' };
    const session = await runInvoke(command.sourceDeviceId, { channel: 'local-db:sessions:get', args: [command.sessionId] });
    if (!session.ok) return classifyFailure(session.error);
    const row = session.result as { id?: string; status?: string; source?: string };
    if (row?.id !== command.sessionId || row.status !== 'active' || (command.resourceRef.kind === 'bot' && row.source !== 'bot')) {
      return { state: 'failed' as const, errorCode: 'RESOURCE_CHANGED' };
    }
  }
  if (!isCurrent()) return { state: 'retry' as const, errorCode: 'RECEIVER_CHANGED' };
  // Only get-projection advertises durable delivery. Enqueue intentionally returns
  // the ordinary queue projection, so its missing version is not a failed receipt.
  const snapshot = await runInvoke(command.sourceDeviceId, { channel: 'maker:input:get-projection', args: [
    command.sessionId, { deliveryClientIds: [command.clientId] },
  ] });
  if (!snapshot.ok) return classifyFailure(snapshot.error);
  const projection = snapshot.result as { inputDeliveryVersion?: number; deliveryReceipts?: Array<{ clientId: string; state: string }> };
  if (projection?.inputDeliveryVersion !== 1) return { state: 'failed' as const, errorCode: 'DURABLE_INPUT_UNSUPPORTED' };
  const receipt = projection.deliveryReceipts?.find(r => r.clientId === command.clientId);
  if (receipt?.state === 'accepted' || receipt?.state === 'pending') return { state: 'accepted' as const };
  if (receipt?.state === 'removed') return { state: 'failed' as const, errorCode: 'INPUT_REMOVED' };
  if (!isCurrent()) return { state: 'retry' as const, errorCode: 'RECEIVER_CHANGED' };
  const result = await runInvoke(command.sourceDeviceId, { channel: 'maker:input:enqueue', args: [
    command.sessionId, command.message, {
      sendAtMs: command.sendAtMs,
      ...(command.expectedClearBoundaryMs !== undefined ? { expectedClearBoundaryMs: command.expectedClearBoundaryMs } : {}),
    },
  ] });
  if (!result.ok) return classifyFailure(result.error);
  return { state: 'accepted' as const };
}

function classifyFailure(error?: { code: string; message: string }) {
  const message = error?.message ?? '';
  const code = /\b(REMOTE_[A-Z0-9_]+)\b/.exec(message)?.[1]
    ?? /\[([A-Z][A-Z0-9_]{1,63})\]/.exec(message)?.[1]
    ?? error?.code ?? 'INTERNAL';
  const terminal = ['ACCESS_REVOKED', 'CHANNEL_NOT_ALLOWED', 'INVALID_PARAMS', 'NOT_FOUND', 'PRECONDITION_FAILED',
    'REMOTE_OPTIMISTIC_INPUT_CLEARED', 'REMOTE_OPTIMISTIC_SESSION_DELETED'].includes(code);
  return { state: terminal ? 'failed' as const : 'retry' as const, errorCode: code };
}

export function createDesktopUmedaInbox(isOwnerOnline: () => boolean) {
  const features = new Map<string, boolean>();
  const request: UmedaCommandRequest = async <T>(path: string, method = 'GET', body?: unknown) => {
    const route = activeSelfHostedRelay();
    if (!route || route.authMode !== 'none' || !isOwnerOnline()) throw new Error('UMEDA_INBOX_UNAVAILABLE');
    const scope = captureDataOwnerBroadcastScope();
    const currentRoute = () => {
      const current = activeSelfHostedRelay();
      return current?.baseUrl === route.baseUrl && current.deviceId === route.deviceId && current.relayId === route.relayId
        && isOwnerOnline() && isDataOwnerBroadcastScopeCurrent(scope);
    };
    const fetch = <R>(p: string, m = 'GET', b?: unknown) => serverApiFetch<R>(p, {
      baseUrl: route.baseUrl, method: m, body: b, authorization: null,
      timeoutMs: 20_000,
      headers: { 'x-umeda-device-id': route.deviceId }, skipAutoRefresh: true, skipSessionInvalidation: true,
    });
    if (!features.has(route.baseUrl)) {
      const info = await fetch<{ features?: string[] }>('/api/device-link/relay/info');
      features.set(route.baseUrl, info.features?.includes(UMEDA_COMMAND_FEATURE) === true);
    }
    if (!features.get(route.baseUrl) || !currentRoute()) throw new Error('UMEDA_INBOX_UNAVAILABLE');
    const result = await fetch<T>(path, method, body);
    if (!currentRoute()) throw new Error('UMEDA_INBOX_UNAVAILABLE');
    return result;
  };
  const receiver = createUmedaCommandConsumer({
    observe: (event, code) => log.debug('durable inbox', { event, code }),
    available: () => {
      const route = activeSelfHostedRelay();
      return !!route && route.authMode === 'none' && features.get(route.baseUrl) !== false && isOwnerOnline();
    },
    request, execute: command => {
      const route = activeSelfHostedRelay(), scope = captureDataOwnerBroadcastScope();
      return executeUmedaCommand(command, () => {
        const current = activeSelfHostedRelay();
        return !!route && route.deviceId === command.targetDeviceId && current?.baseUrl === route.baseUrl
          && current.relayId === route.relayId && current.deviceId === route.deviceId
          && isOwnerOnline() && isDataOwnerBroadcastScopeCurrent(scope);
      });
    },
  });
  return {
    stop: receiver.stop,
    wake() {
      const route = activeSelfHostedRelay();
      log.debug('durable inbox wake', { ownerOnline: isOwnerOnline(), personalRelay: route?.authMode === 'none',
        feature: route ? features.get(route.baseUrl) ?? 'unknown' : 'none' });
      receiver.wake();
    },
  };
}
