/** Unit: production outbox handoff across a lost HTTP reply, phone restart, cancellation
 * and relay switch. Existing direct-delivery tests require a live Mac and miss this path.
 * Minimal case: one cached task + one message while the host is asleep. No real waits. */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/api/client', () => ({ apiFetchRaw: vi.fn() }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'unused' }));
import { apiFetchRaw } from '@/api/client';
import { setActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import { canUseUmedaOutbox, createUmedaOutboxDelivery } from '@/session/umedaOutbox';
import { createDurableOutbox, isDurableOutboxHandedOff, isDurableOutboxUnsent, type DurableOutboxRecord } from '@/session/durableOutbox';
import type { RemoteSession } from '@/session/types';
import { UMEDA_COMMAND_FEATURE, type UmedaCommandReceipt } from '@cindy/device-link';

const route = { baseUrl: 'https://relay.invalid', relayId: 'relay', name: 'test', authMode: 'none' as const,
  deviceId: 'phone', credential: null, signing: null };
afterEach(() => { setActiveSelfHostedRelay(null); vi.clearAllMocks(); });
async function setup() {
  setActiveSelfHostedRelay(route);
  const disk = new Map<string, string>();
  const storage = { getAllKeys: async () => [...disk.keys()], getItem: async (k: string) => disk.get(k) ?? null,
    setItem: async (k: string, v: string) => { disk.set(k, v); }, removeItem: async (k: string) => { disk.delete(k); } };
  let store = createDurableOutbox(storage); await store.activate('owner');
  const session = { id: 'task', deviceLinkDeviceId: 'mac', workingDir: '/project', model: 'test',
    permissionMode: 'ask', agentKind: 'codex', status: 'active', clearedAt: null } as RemoteSession;
  await store.add({ version: 1, accountId: 'owner', deviceId: 'mac', createdAt: 1, state: 'queued', uploads: [],
    item: { clientId: 'input', sessionId: 'task', text: 'do this', quotesEncoded: false, agentReferences: [],
      pastedTextRanges: [], slashCommandRanges: [], permissionModeAtSend: 'ask', attachmentSlots: [], slotMeta: [],
      slotByLocalId: {}, waitingIds: [], failedIds: [], enqueueError: null, phase: 'uploading' } });
  let state: UmedaCommandReceipt['state'] = 'queued';
  let loseReply = false;
  const receipt = () => ({ clientId: 'input', sourceDeviceId: 'phone', targetDeviceId: 'mac', sessionId: 'task',
    state, createdAt: 1, expiresAt: 86_400_001 });
  vi.mocked(apiFetchRaw).mockImplementation(async (path, options) => {
    options.assertCurrent?.();
    if (path.endsWith('/info')) return { features: [UMEDA_COMMAND_FEATURE] };
    if (path.includes('/capabilities')) return { supported: true };
    if (options.method === 'DELETE') state = 'cancelled';
    if (options.method === 'POST' && loseReply) { loseReply = false; throw new Error('reply lost'); }
    return { receipt: receipt() };
  });
  const row = () => store.getSnapshot()[0];
  const create = () => createUmedaOutboxDelivery({ sessions: () => [session], guard() {},
    isCurrent: r => store.getSnapshot().includes(r), upload: async () => { throw new Error('unexpected upload'); },
    discardUploads() {}, failure: code => code });
  const deliver = (runner = create()) => runner(row(), patch => store.update(row(), patch));
  return { row, deliver, session, setState: (s: typeof state) => { state = s; },
    loseReply: () => { loseReply = true; },
    update: (patch: Partial<DurableOutboxRecord>) => store.update(row(), patch),
    restart: async () => { store = createDurableOutbox(storage); await store.activate('owner'); },
  };
}
describe('personal cloud outbox', () => {
  it('keeps an explicit earlier empty clear boundary even if the cached task was cleared later', async () => {
    const h = await setup(); await h.update({ clearBoundaryMs: null });
    h.session.clearedAt = '2026-11-20T00:00:00Z';
    await h.deliver();
    expect(h.row().relay?.input.expectedClearBoundaryMs).toBeNull();
  });
  it('pins the original envelope before sending and repeats exactly that input after a lost reply and cold start', async () => {
    const h = await setup(); h.loseReply();
    await expect(h.deliver()).rejects.toThrow('reply lost');
    expect(h.row().relay?.state).toBe('submitting');
    expect(isDurableOutboxUnsent(h.row())).toBe(false);
    const original = h.row().relay!.input;
    await h.restart();
    expect(await h.deliver()).toBe('waiting');
    expect(h.row().relay).toMatchObject({ state: 'queued', input: original });
    expect(isDurableOutboxHandedOff(h.row())).toBe(true);
    const writes = vi.mocked(apiFetchRaw).mock.calls.filter(([, o]) => o.method === 'POST');
    expect(writes.map(([, o]) => o.body)).toEqual([original, original]);
    expect(original.message).toMatchObject({ durableDelivery: true, clientId: 'input', text: 'do this', permissionMode: 'ask' });
  });
  it('keeps the bubble and ownership until the Mac accepts, and cancels unclaimed input through the cloud', async () => {
    const h = await setup();
    expect(await h.deliver()).toBe('waiting');
    await h.update({ cancelRequested: true });
    expect(await h.deliver()).toBe('cancelled');
    expect(vi.mocked(apiFetchRaw).mock.calls.at(-1)?.[1].method).toBe('DELETE');
    expect(h.row()).toBeDefined();
  });
  it('accepts only a host receipt, keeps terminal failures reviewable, and never routes a pinned command to another relay', async () => {
    const h = await setup(); await h.deliver();
    setActiveSelfHostedRelay({ ...route, baseUrl: 'https://another.invalid' });
    expect(canUseUmedaOutbox(h.row(), [h.session])).toBe(false);
    // A pinned record must remain parked, never silently enter the other relay's direct path.
    expect(await h.deliver()).toBe('waiting');
    setActiveSelfHostedRelay(route); h.setState('accepted');
    expect(await h.deliver()).toBe('accepted');
    expect(h.row()).toMatchObject({ state: 'host-owned', retrySafe: true, relay: { state: 'accepted' } });
    const expired = await setup(); await expired.deliver(); expired.setState('expired');
    expect(await expired.deliver()).toBe('waiting');
    expect(expired.row()).toMatchObject({ state: 'failed', relay: { terminal: true }, error: 'COMMAND_EXPIRED' });
  });
});
