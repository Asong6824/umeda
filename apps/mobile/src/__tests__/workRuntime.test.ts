/** Value: the production native service must save object + outbox atomically,
 * preserve offline drafts after a restart and fence delayed old-owner opens.
 * Shared store tests cannot verify Expo adapter or app lifecycle. Minimum input:
 * one offline create, an outbox write failure, an owner switch while opening SQL.
 * Tier: unit, real in-memory SQLite behind native ports; no network or waits.
 * Standalone file: 0.97s locally (2026-11-23).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ owner: { accountKey: 'fixture-owner', accountId: 'fixture', generation: 1 }, failOutbox: false,
  delay: null as null | (() => Promise<void>), raw: new Map<string, any>() }));
vi.mock('react-native', () => ({ AppState: { currentState: 'background' } }));
vi.mock('expo-crypto', () => ({ randomUUID: () => crypto.randomUUID() }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => state.owner, isMobileAuthOwnerCurrent: (value: unknown) => value === state.owner }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getActiveSelfHostedRelay: () => ({ authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'fixture' }) }));
vi.mock('@/storage/personalRelayScope', () => ({ personalRelayStorageScope: (owner: string) => owner }));
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: async (name: string) => {
  if (state.delay) await state.delay();
  let db = state.raw.get(name) as DatabaseSync | undefined;
  if (!db) { db = new DatabaseSync(':memory:'); state.raw.set(name, db); }
  const raw = db;
  return {
    execAsync: async (sql: string) => { raw.exec(sql); },
    getFirstAsync: async (sql: string) => raw.prepare(sql).get(),
    getFirstSync: (sql: string, ...p: never[]) => raw.prepare(sql).get(...p) ?? null,
    getAllSync: (sql: string, ...p: never[]) => raw.prepare(sql).all(...p),
    runSync: (sql: string, ...p: never[]) => { if (state.failOutbox && sql.includes('umeda_work_outbox')) throw new Error('synthetic disk failure'); return raw.prepare(sql).run(...p); },
    withTransactionSync: (fn: () => void) => { raw.exec('BEGIN'); try { fn(); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; } },
    withExclusiveTransactionAsync: async (fn: (tx: { execAsync(sql: string): Promise<void> }) => Promise<void>) => { raw.exec('BEGIN'); try { await fn({ execAsync: async sql => { raw.exec(sql); } }); raw.exec('COMMIT'); } catch (e) { raw.exec('ROLLBACK'); throw e; } },
    closeAsync: async () => {},
  };
} }));
import { mobileWork, stopMobileWork } from '@/work-management/runtime';

afterEach(async () => {
  stopMobileWork(); await Promise.resolve(); state.failOutbox = false; state.delay = null;
  for (const db of state.raw.values()) db.close(); state.raw.clear();
  state.owner = { accountKey: 'fixture-owner', accountId: 'fixture', generation: 1 };
});
describe('native work storage lifecycle', () => {
  it('keeps objects and queued commands after restart, while a failed queue write rolls back the business save', async () => {
    const work = mobileWork()!;
    const first = await work.execute({ operation: 'create', request_id: 'offline-create', kind: 'task', title: 'Offline draft' });
    const id = first.items![0].id;
    expect(await work.replica({ operation: 'status' })).toMatchObject({ queued: 1 });
    stopMobileWork(work);
    const reopened = mobileWork()!;
    expect(await reopened.execute({ operation: 'get', id })).toMatchObject({ item: { title: 'Offline draft', revision: 1 } });
    state.failOutbox = true;
    await expect(reopened.execute({ operation: 'update', request_id: 'failed', summary: 'Attempt', changes: [{ id, expected_revision: 1, status: 'done' }] })).rejects.toThrow('synthetic disk failure');
    state.failOutbox = false;
    expect(await reopened.execute({ operation: 'get', id })).toMatchObject({ item: { status: 'todo', revision: 1 } });
    expect(await reopened.replica({ operation: 'status' })).toMatchObject({ queued: 1 });
    await expect(reopened.execute({ operation: 'record', request_id: 'failed' })).rejects.toThrow('WORK_NOT_FOUND');
  });
  it('does not save into a new owner when the old SQL open finishes late', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const opening = new Promise<void>(resolve => { entered = resolve; });
    state.delay = async () => { entered(); await gate; };
    const old = mobileWork()!;
    const pending = old.execute({ operation: 'create', request_id: 'stale', kind: 'task', title: 'Old draft' });
    await opening;
    state.owner = { accountKey: 'other-owner', accountId: 'other', generation: 2 }; stopMobileWork(old);
    release(); await expect(pending).rejects.toThrow('WORK_CONTEXT_CHANGED'); state.delay = null;
    const next = mobileWork()!;
    expect(await next.execute({ operation: 'list' })).toMatchObject({ items: [] });
    expect(await next.replica({ operation: 'status' })).toMatchObject({ queued: 0 });
  });
});
