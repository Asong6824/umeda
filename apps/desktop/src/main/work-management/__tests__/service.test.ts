import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  owner: 'owner-a', stamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 }, pending: false,
  route: { authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'fixture' },
  db: { tx: vi.fn(), queryOne: vi.fn() }, handlers: new Map<string, (...args: unknown[]) => unknown>(), trusted: true,
  send: vi.fn(), warn: vi.fn(), netFetch: vi.fn(),
}));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => state.owner, getActiveDataOwnerPushStamp: () => state.stamp, isAppSessionBoundaryPending: () => state.pending }));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => state.db, tryGetDbClient: () => state.db }));
vi.mock('../../device-link/selfHostedRelayRouting', () => ({ activeSelfHostedRelay: () => state.route }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: state.warn }) }));
vi.mock('electron', () => ({ net: { fetch: state.netFetch }, ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn) }, BrowserWindow: { getAllWindows: () => [{ webContents: { send: state.send } }] } }));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: () => { if (!state.trusted) throw new Error('untrusted'); }, isTrustedAppRendererWindow: () => true }));
import { executeWorkManagementRequest, setWorkManagementChangeListener } from '../service';
import { registerWorkManagementIpc } from '../ipc';
import { executeWorkManagement } from '../host';
import { configureWorkSyncNotification, startWorkSync } from '../sync';

// Value: production service + IPC registration must share human/Agent writes,
// fence stale owners and notify only views after commit. DB tests cannot cover
// Electron ingress or async owner changes. Minimal failure: old-owner reply after
// a switch; a committed write whose renderer notification fails. Tier: unit.
describe('work management host boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.owner = 'owner-a'; state.pending = false; state.trusted = true;
    state.stamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 }; state.handlers.clear();
    state.db.tx.mockResolvedValue({ items: [], status: 'local_saved' }); state.db.queryOne.mockResolvedValue({ cleared_at: 0 });
    registerWorkManagementIpc();
  });
  const create = { operation: 'create' as const, request_id: 'fixture-create', kind: 'task' as const, title: 'Read' };
  it('routes human and Agent operations through the same transaction and broadcasts owner-only invalidation', async () => {
    await state.handlers.get('umeda-work:execute')!({}, create, state.stamp);
    expect(state.db.tx).toHaveBeenLastCalledWith('umedaWork.execute', expect.objectContaining({ actor: { kind: 'user' }, request: create }));
    await executeWorkManagement({ sessionId: 'execution', agentKind: 'codex', workingDir: '/fixture' }, create);
    expect(state.db.tx).toHaveBeenLastCalledWith('umedaWork.execute', expect.objectContaining({ actor: { kind: 'agent_report', session_id: 'execution', epoch: 0, agent_kind: 'codex' } }));
    expect(state.send).toHaveBeenCalledWith('umeda-work:changed', state.stamp);
    state.send.mockClear();
    await executeWorkManagementRequest({ kind: 'user' }, { operation: 'list' });
    expect(state.send).not.toHaveBeenCalled();
  });
  it('rejects untrusted windows and stale renderer generations before reading or writing', async () => {
    const handler = state.handlers.get('umeda-work:execute')!;
    state.trusted = false;
    await expect(handler({}, create, state.stamp)).rejects.toThrow('untrusted');
    state.trusted = true;
    await expect(handler({}, create, { ...state.stamp, ownerGeneration: 0 })).rejects.toThrow('Work data owner changed');
    expect(state.db.tx).not.toHaveBeenCalled();
  });
  it('drops an old owner reply and never publishes its notification', async () => {
    let release!: (value: unknown) => void;
    state.db.tx.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = executeWorkManagementRequest({ kind: 'user' }, create);
    state.owner = 'owner-b'; state.stamp = { dataOwnerId: 'owner-b', ownerGeneration: 2 };
    release({ items: [{ title: 'old owner' }] });
    await expect(pending).rejects.toThrow('WORK_CONTEXT_CHANGED');
    expect(state.send).not.toHaveBeenCalled();
  });
  it('preserves a committed receipt when a view cannot be notified, and returns typed conflicts', async () => {
    setWorkManagementChangeListener(() => { throw new Error('closed'); });
    await expect(executeWorkManagementRequest({ kind: 'user' }, create)).resolves.toMatchObject({ status: 'local_saved' });
    registerWorkManagementIpc();
    state.db.tx.mockResolvedValueOnce({ ok: false, errorCode: 'WORK_VERSION_CONFLICT' });
    await expect(state.handlers.get('umeda-work:execute')!({}, create, state.stamp)).rejects.toMatchObject({ code: 'WORK_VERSION_CONFLICT' });
  });
});

// Regression: business sync must honor the same system proxy as other app HTTP
// requests. Existing host/SQLite tests do not exercise the production HTTP port.
// Tier: unit; fake clock and in-memory
// responses. Minimum failures: one queued create with Node fetch unavailable;
// an old owner's response arriving after the account switches; recovery with
// an empty feed must clear the paused view. Standalone: 1.17s (2026-11-23).
describe('work sync app networking', () => {
  let loop: ReturnType<typeof startWorkSync> | undefined;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks();
    state.owner = 'owner-a'; state.pending = false;
    state.stamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    configureWorkSyncNotification(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('bare Node fetch cannot use the app proxy'));
  });
  afterEach(() => { loop?.stop(); loop = undefined; vi.restoreAllMocks(); vi.useRealTimers(); });
  it('delivers business reads and writes through app networking without leaking account authorization', async () => {
    let cursor = 0;
    const envelope = { version: 1, request: { operation: 'create', request_id: 'queued', kind: 'goal', title: 'Read' }, actor: { kind: 'user' }, created_id: 'goal', now: 1 };
    state.db.tx.mockImplementation(async (_name, input) => {
      if (input.operation === 'checkpoint') return { cursor };
      if (input.operation === 'pending') return cursor ? {} : { envelope };
      if (input.operation === 'apply') { cursor = input.feed.cursor; return { cursor }; }
      return {};
    });
    let committed = false;
    state.netFetch.mockImplementation(async (_url, init) => {
      if (init.method === 'POST') { committed = true; return Response.json({ request_id: 'queued', status: 'committed' }); }
      return Response.json({ epoch: 'fixture', cursor: committed ? 1 : 0, more: false, commits: committed ? [{ cursor: 1 }] : [] });
    });
    loop = startWorkSync(() => true);
    await vi.waitFor(() => expect(cursor).toBe(1), { interval: 1, timeout: 1000 });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(state.netFetch).toHaveBeenCalledWith('https://relay.invalid/api/work/commits', expect.objectContaining({ method: 'POST', body: JSON.stringify(envelope), signal: expect.any(AbortSignal) }));
    expect(state.netFetch.mock.calls.every(([, init]) => !('Authorization' in init.headers) && !('authorization' in init.headers))).toBe(true);
    expect(state.warn).not.toHaveBeenCalled();
  });
  it('refreshes the saved sync status after network recovery even when no business records changed', async () => {
    state.db.tx.mockImplementation(async (_name, input) => input.operation === 'checkpoint' ? { cursor: 8 } : {});
    state.netFetch.mockRejectedValueOnce(new Error('temporarily offline')).mockImplementation(async () => Response.json({ epoch: 'fixture', cursor: 8, commits: [], more: false }));
    const changed = vi.fn(); configureWorkSyncNotification(changed);
    loop = startWorkSync(() => true);
    await vi.waitFor(() => expect(state.warn).toHaveBeenCalledOnce(), { interval: 1, timeout: 1000 });
    changed.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(state.db.tx.mock.calls.some(([, input]) => input.operation === 'apply')).toBe(true);
    expect(changed).toHaveBeenCalledOnce();
  });
  it('drops a delayed network response after the owner changes without applying it to the next owner', async () => {
    state.db.tx.mockImplementation(async (_name, input) => input.operation === 'checkpoint' ? { cursor: 0 } : {});
    let deliver!: (response: Response) => void;
    state.netFetch.mockImplementation(() => new Promise<Response>(resolve => { deliver = resolve; }));
    loop = startWorkSync(() => true);
    await vi.waitFor(() => expect(state.netFetch).toHaveBeenCalledTimes(1), { interval: 1, timeout: 1000 });
    state.owner = 'owner-b'; state.stamp = { dataOwnerId: 'owner-b', ownerGeneration: 2 };
    deliver(Response.json({ epoch: 'fixture', cursor: 0, commits: [], more: false }));
    await vi.advanceTimersByTimeAsync(0);
    expect(state.db.tx.mock.calls.some(([, input]) => input.operation === 'apply' || input.operation === 'network')).toBe(false);
  });
});
