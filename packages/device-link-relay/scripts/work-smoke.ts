/** Production workerd + SQLite DO + two local SQL replicas. Synthetic data only. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { startCloudflareRelay } from './cloudflare-runtime';
import { runWorkStore, type WorkSqlDatabase } from '@cindy/maker-shared/work-store';
import { runWorkReplica, WORK_DATABASE_SCHEMA } from '@cindy/maker-shared/work-replication';
import { syncWork } from '@cindy/maker-shared/work-sync';
import type { WorkManagementRequest, WorkItem } from '@cindy/maker-shared/work-management';

const server = await startCloudflareRelay(undefined, undefined, true);
const handles: DatabaseSync[] = [];
function replica() {
  const native = new DatabaseSync(':memory:'); handles.push(native); native.exec(WORK_DATABASE_SCHEMA);
  let depth = 0, counter = 0;
  const db: WorkSqlDatabase = { prepare: sql => ({ get: (...p) => native.prepare(sql).get(...p as never[]), all: (...p) => native.prepare(sql).all(...p as never[]), run: (...p) => native.prepare(sql).run(...p as never[]) }),
    transaction: fn => () => { if (depth) return fn(); native.exec('BEGIN'); depth++; try { const v = fn(); native.exec('COMMIT'); return v; } catch (e) { native.exec('ROLLBACK'); throw e; } finally { depth--; } } };
  const execute = (request: WorkManagementRequest) => db.transaction(() => { const input = { request, actor: { kind: 'user' as const }, created_id: 'synthetic-item', now: ++counter }; const v = runWorkStore(db, input); runWorkReplica(db, { operation: 'capture', input }); return v; })();
  let loseAck = false;
  return { db, execute, loseNextAck() { loseAck = true; }, get: () => runWorkStore(db, { request: { operation: 'get', id: 'synthetic-item' }, actor: { kind: 'user' }, created_id: 'read', now: 1 }).item as WorkItem,
    sync: () => syncWork({ scope: 'synthetic', current: () => true, changed() {}, replica: async input => runWorkReplica(db, input, runWorkStore), async http(path, body) {
      const response = await fetch(server.localUrl + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
      const value = await response.json(); if (loseAck && body) { loseAck = false; throw new Error('lost acknowledgement'); }
      return { status: response.status, body: value };
    } }),
  };
}
try {
  const info = await (await fetch(server.localUrl + '/api/device-link/relay/info')).json() as { features: string[] };
  assert(info.features.includes('work-sync-v1'));
  const a = replica(), b = replica();
  a.execute({ operation: 'create', request_id: 'create', kind: 'project', title: 'Synthetic smoke' }); await a.sync(); await b.sync();
  assert.equal(b.get().title, 'Synthetic smoke');
  b.execute({ operation: 'update', request_id: 'update', summary: 'Smoke result', changes: [{ id: 'synthetic-item', expected_revision: 1, progress: { percent: 40, basis: 'Synthetic milestone' } }] });
  b.loseNextAck(); await assert.rejects(b.sync(), /lost acknowledgement/); await b.sync(); await a.sync();
  assert.equal(a.get().revision, 2); assert.equal(a.get().progress?.percent, 40);
  const changes = await (await fetch(server.localUrl + '/api/work/changes?after=0')).json() as { commits: unknown[] };
  assert.equal(changes.commits.length, 2);
  console.log(JSON.stringify({ productionWorker: true, replicas: 2, lostAckDeduplicated: true, commits: 2 }));
} finally { for (const db of handles) db.close(); await server.close(); }
