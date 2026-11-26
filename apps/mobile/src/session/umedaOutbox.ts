import {
  UMEDA_COMMAND_FEATURE, UMEDA_COMMAND_MAX_BYTES, UMEDA_COMMAND_PATH,
  type UmedaCommandInput, type UmedaCommandReceipt,
} from '@cindy/device-link';
import { apiFetchRaw } from '@/api/client';
import { getActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import type { DurableOutboxRecord } from './durableOutbox';
import type { QueuedRemoteMessage, RemoteSession, RemoteSerializedAttachment } from './types';
import { buildQueuedTextMessage } from './inputProjection';
import { outboxItemAttachments } from './sessionOutbox';
import { readChatReplyQuote } from '@cindy/maker-shared/chat-reply-quote';

/** Only existing, cached tasks can be handed off without consulting a sleeping host. */
export function canUseUmedaOutbox(record: DurableOutboxRecord, sessions: readonly RemoteSession[]) {
  const route = getActiveSelfHostedRelay();
  if (!route || route.authMode !== 'none' || !route.deviceId || record.chat || record.creation
    || record.suspended || (record.state === 'failed' && !record.cancelRequested)) return false;
  if (record.relay) return record.relay.baseUrl === route.baseUrl && record.relay.relayId === route.relayId
    && record.relay.sourceDeviceId === route.deviceId && (record.relay.state !== 'accepted' || record.cancelRequested === true);
  // Cross-computer history references must first be resolved by their existing guarded path.
  if (record.enqueueStarted === true || record.state !== 'queued' || record.item.sessionRefs?.length) return false;
  return sessions.some(s => s.id === record.item.sessionId && s.deviceLinkDeviceId === record.deviceId && !!s.workingDir);
}

export function createUmedaOutboxDelivery(deps: {
  sessions(): readonly RemoteSession[];
  guard(): void;
  isCurrent(record: DurableOutboxRecord): boolean;
  upload(record: DurableOutboxRecord, upload: DurableOutboxRecord['uploads'][number]): Promise<RemoteSerializedAttachment>;
  discardUploads(record: DurableOutboxRecord, files: RemoteSerializedAttachment[]): void;
  failure(code: string): string;
}) {
  const supported = new Map<string, { until: number; value: Promise<boolean> }>();
  const request = <T>(path: string, method = 'GET', body?: unknown) => {
    const route = getActiveSelfHostedRelay();
    if (!route || route.authMode !== 'none') throw new Error('UMEDA_RELAY_CHANGED');
    return apiFetchRaw<T>(path, { baseUrl: route.baseUrl, method, body, assertCurrent: () => {
      deps.guard();
      const current = getActiveSelfHostedRelay();
      if (!current || current.baseUrl !== route.baseUrl || current.relayId !== route.relayId
        || current.deviceId !== route.deviceId) throw new Error('UMEDA_RELAY_CHANGED');
    } });
  };
  return async (initial: DurableOutboxRecord, update: (patch: Partial<DurableOutboxRecord>) => Promise<DurableOutboxRecord>) => {
    const currentRoute = getActiveSelfHostedRelay();
    if (initial.relay && (!currentRoute || currentRoute.authMode !== 'none'
      || initial.relay.baseUrl !== currentRoute.baseUrl || initial.relay.relayId !== currentRoute.relayId
      || initial.relay.sourceDeviceId !== currentRoute.deviceId)) return 'waiting' as const;
    if (initial.relay?.terminal && !initial.cancelRequested) return 'waiting' as const;
    if (!canUseUmedaOutbox(initial, deps.sessions())) return 'fallback' as const;
    let r = initial;
    const save = async (patch: Partial<DurableOutboxRecord>) => { r = await update(patch); };
    const route = getActiveSelfHostedRelay()!;
    const guard = () => { deps.guard(); if (!deps.isCurrent(r)) throw new Error('OUTBOX_STALE_WRITE'); };
    if (!r.relay) {
      const key = JSON.stringify([route.baseUrl, r.deviceId]);
      let entry = supported.get(key);
      if (!entry || entry.until <= Date.now()) {
        const value = request<{ features?: string[] }>('/api/device-link/relay/info').then(async info =>
          info.features?.includes(UMEDA_COMMAND_FEATURE) === true
            && (await request<{ supported: boolean }>(`${UMEDA_COMMAND_PATH}/capabilities?targetDeviceId=${encodeURIComponent(r.deviceId)}`)).supported);
        entry = { until: Infinity, value };
        const current = entry;
        supported.set(key, current);
        value.then(ok => { if (!ok) current.until = Date.now() + 60_000; })
          .catch(() => { if (supported.get(key) === current) supported.delete(key); });
      }
      if (!await entry.value) return 'fallback' as const;
      guard();
      for (const upload of r.uploads) {
        if (r.item.attachmentSlots[upload.slot]) continue;
        let attachment: RemoteSerializedAttachment;
        try { attachment = await deps.upload(r, upload); }
        catch (error) { guard(); await save({ failedUploadSlot: upload.slot }); throw error; }
        try {
          guard();
          await save({ item: { ...r.item,
            attachmentSlots: r.item.attachmentSlots.map((old, slot) => slot === upload.slot ? attachment : old),
            waitingIds: r.item.waitingIds.filter(id => r.item.slotByLocalId[id] !== upload.slot),
          } });
        } catch (error) { deps.discardUploads(r, [attachment]); throw error; }
      }
      const session = deps.sessions().find(s => s.id === r.item.sessionId && s.deviceLinkDeviceId === r.deviceId)!;
      const rebuilt = buildQueuedTextMessage({ ...session, permissionMode: r.item.permissionModeAtSend }, r.item.text,
        new Date(r.createdAt), r.item.clientId, { attachments: outboxItemAttachments(r.item),
          planMode: r.item.planModeAtSend, quotesEncoded: r.item.quotesEncoded,
          agentReferences: r.item.agentReferences, pastedTextRanges: r.item.pastedTextRanges,
          slashCommandRanges: r.item.slashCommandRanges, replyQuote: readChatReplyQuote(r.item.replyQuote) ?? undefined });
      const prepared: QueuedRemoteMessage = { ...rebuilt, ...r.template,
        files: rebuilt.files, persistedContent: rebuilt.persistedContent, chatMessage: rebuilt.chatMessage,
        durableDelivery: true };
      const boundary = r.clearBoundaryMs !== undefined ? r.clearBoundaryMs : (session.clearedAt ? Date.parse(session.clearedAt) : null);
      const input: UmedaCommandInput = { clientId: r.item.clientId, targetDeviceId: r.deviceId,
        sessionId: r.item.sessionId, message: prepared as unknown as Record<string, unknown>,
        sendAtMs: r.sendAtMs ?? r.createdAt, expectedClearBoundaryMs: boundary,
        ...(r.resourceRef ? { resourceRef: r.resourceRef } : {}) };
      // Large messages retain the ordinary transport rather than claiming cloud ownership.
      if (new TextEncoder().encode(JSON.stringify(input)).length > UMEDA_COMMAND_MAX_BYTES) return 'fallback' as const;
      const wireInput = JSON.parse(JSON.stringify(input)) as UmedaCommandInput;
      await save({ prepared, retrySafe: true, sendAtMs: input.sendAtMs, enqueueStarted: true,
        relay: { baseUrl: route.baseUrl, relayId: route.relayId, sourceDeviceId: route.deviceId!, state: 'submitting', input: wireInput } });
    }
    if (r.relay!.state === 'accepted') return 'fallback' as const;
    const path = `${UMEDA_COMMAND_PATH}/${encodeURIComponent(r.item.clientId)}`;
    let { receipt } = r.relay!.state === 'submitting'
      ? await request<{ receipt: UmedaCommandReceipt }>(UMEDA_COMMAND_PATH, 'POST', r.relay!.input)
      : await request<{ receipt: UmedaCommandReceipt }>(path, r.cancelRequested ? 'DELETE' : 'GET');
    guard();
    if (r.cancelRequested && r.relay!.state === 'submitting' && receipt.state === 'queued') {
      ({ receipt } = await request<{ receipt: UmedaCommandReceipt }>(path, 'DELETE'));
      guard();
    }
    if (receipt.targetDeviceId !== r.deviceId || receipt.sessionId !== r.item.sessionId
      || receipt.sourceDeviceId !== route.deviceId || receipt.clientId !== r.item.clientId) throw new Error('UMEDA_RECEIPT_MISMATCH');
    if (receipt.state === 'cancelled') return 'cancelled' as const;
    if (receipt.state === 'failed' || receipt.state === 'expired') {
      if (r.cancelRequested) return 'cancelled' as const;
      await save({ relay: { ...r.relay!, terminal: true }, state: 'failed',
        error: deps.failure(receipt.errorCode ?? (receipt.state === 'expired' ? 'COMMAND_EXPIRED' : 'COMMAND_FAILED')) });
      return 'waiting' as const;
    }
    if (receipt.state === 'accepted') {
      await save({ relay: { ...r.relay!, state: 'accepted' }, state: 'host-owned', retrySafe: true, error: undefined });
      return 'accepted' as const;
    }
    await save({ relay: { ...r.relay!, state: 'queued' }, state: 'queued', error: undefined });
    return 'waiting' as const;
  };
}
