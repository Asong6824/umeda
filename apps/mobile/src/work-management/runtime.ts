import * as SQLite from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { AppState } from 'react-native';
import { runWorkStore, type WorkSqlDatabase } from '@cindy/maker-shared/work-store';
import { runWorkReplica, WORK_DATABASE_SCHEMA, type WorkReplicaRequest } from '@cindy/maker-shared/work-replication';
import { createWorkSyncLoop, syncWork } from '@cindy/maker-shared/work-sync';
import type { WorkManagementRequest, WorkManagementResponse } from '@cindy/maker-shared/work-management';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { getActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import { personalRelayStorageScope } from '@/storage/personalRelayScope';

const listeners = new Set<() => void>();
export const subscribeWorkChanges = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
function changed() { for (const listener of listeners) { try { listener(); } catch { /* View invalidation cannot roll back a committed save. */ } } }
interface WorkRuntime {
  key: string;
  execute(request: WorkManagementRequest): Promise<WorkManagementResponse>;
  replica(request: WorkReplicaRequest): Promise<Record<string, unknown>>;
  wake(): void;
  pause(): void;
  stop(): void;
}
let active: WorkRuntime | null = null;

/** The native app owns durable data and delivery; screens only request and render. */
export function mobileWork(): WorkRuntime | null {
  const owner = getMobileAuthOwner(), route = getActiveSelfHostedRelay();
  if (!route || route.authMode !== 'none' || owner.switching) { stopMobileWork(); return null; }
  const namespace = personalRelayStorageScope(owner.accountKey, route), key = JSON.stringify([namespace, owner.generation, route.baseUrl]);
  if (active?.key === key) return active;
  stopMobileWork();
  let alive = true, database: Promise<SQLite.SQLiteDatabase> | undefined, tail: Promise<unknown> = Promise.resolve();
  let loop: ReturnType<typeof createWorkSyncLoop> | undefined;
  const controllers = new Set<AbortController>();
  const valid = () => alive && isMobileAuthOwnerCurrent(owner) && route.baseUrl === getActiveSelfHostedRelay()?.baseUrl && route.relayId === getActiveSelfHostedRelay()?.relayId;
  const open = () => database ??= (async () => {
    const db = await SQLite.openDatabaseAsync(`umeda-work-${namespace}.sqlite`);
    try {
      const version = (await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
      if (version > 2) throw new Error('WORK_DATABASE_TOO_NEW');
      await db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      await db.withExclusiveTransactionAsync(async tx => { await tx.execAsync(WORK_DATABASE_SCHEMA); await tx.execAsync('PRAGMA user_version=2;'); });
      return db;
    } catch (error) { await db.closeAsync(); throw error; }
  })().catch(error => { database = undefined; throw error; });
  const transact = <T,>(operation: (db: WorkSqlDatabase) => T): Promise<T> => {
    const result = tail.catch(() => undefined).then(async () => {
      if (!valid()) throw new Error('WORK_CONTEXT_CHANGED');
      const native = await open();
      if (!valid()) throw new Error('WORK_CONTEXT_CHANGED');
      let depth = 0;
      const db: WorkSqlDatabase = {
        prepare: sql => ({
          get: (...p) => native.getFirstSync(sql, ...(p as SQLite.SQLiteBindValue[])) ?? undefined,
          all: (...p) => native.getAllSync(sql, ...(p as SQLite.SQLiteBindValue[])),
          run: (...p) => native.runSync(sql, ...(p as SQLite.SQLiteBindValue[])),
        }),
        transaction: fn => () => {
          if (depth) return fn();
          let value: ReturnType<typeof fn>;
          native.withTransactionSync(() => { depth++; try { value = fn(); } finally { depth--; } });
          return value!;
        },
      };
      return db.transaction(() => operation(db))();
    });
    tail = result; return result;
  };
  const replica = (request: WorkReplicaRequest) => transact(db => runWorkReplica(db, request, runWorkStore));
  const start = () => {
    if (!valid() || AppState.currentState !== 'active') return;
    if (!loop) loop = createWorkSyncLoop(async current => { try { return await syncWork({ scope: JSON.stringify([route.baseUrl, route.relayId]), replica,
      current: () => current() && valid() && AppState.currentState === 'active', changed,
      async http(path, body) {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30_000); controllers.add(controller);
        try {
          const response = await fetch(route.baseUrl + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
          if (!valid() || Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('WORK_SYNC_INVALID_REPLY');
          const text = await response.text();
          if (!valid() || text.length > 2 * 1024 * 1024) throw new Error('WORK_SYNC_INVALID_REPLY');
          return { status: response.status, body: JSON.parse(text) as unknown };
        } finally { clearTimeout(timeout); controllers.delete(controller); }
      },
    }); } catch (error) { if (valid() && current() && AppState.currentState === 'active') { await replica({ operation: 'network', error: error instanceof Error ? error.message : '' }); changed(); } throw error; } }, changed);
    loop.wake();
  };
  const pause = () => { loop?.stop(); loop = undefined; for (const controller of controllers) controller.abort(); };
  active = { key, replica, wake: start, pause,
    async execute(request) {
      const transaction = { request, actor: { kind: 'user' as const }, created_id: randomUUID(), now: Date.now() };
      const result = await transact(db => {
        if (request.operation === 'sync_status') return runWorkReplica(db, { operation: 'status' });
        if (request.operation === 'sync_conflict') return runWorkReplica(db, { operation: 'conflict', request_id: request.request_id });
        if (request.operation === 'sync_resolve') return runWorkReplica(db, { operation: 'resolve', request_id: request.request_id, choice: request.choice, nonce: transaction.created_id, now: transaction.now }, runWorkStore);
        const response = runWorkStore(db, transaction);
        if (request.operation === 'create' || request.operation === 'update') runWorkReplica(db, { operation: 'capture', input: transaction });
        return response;
      });
      if (!valid()) throw new Error('WORK_CONTEXT_CHANGED');
      if (request.operation === 'create' || request.operation === 'update' || request.operation === 'sync_resolve') { changed(); start(); }
      return result as WorkManagementResponse;
    },
    stop() { alive = false; pause(); void tail.catch(() => undefined).then(async () => { if (database) await (await database).closeAsync(); }).catch(() => undefined); },
  };
  start(); return active;
}
export function stopMobileWork(expected?: WorkRuntime) { if (expected && active !== expected) return; active?.stop(); active = null; }
export function wakeMobileWork() { mobileWork()?.wake(); }
