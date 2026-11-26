/** Value: production business HTTP -> atomic cloud SQL -> two durable local replicas.
 * Existing relay tests only cover execution delivery / vault files. Minimum failures:
 * lost POST receipt, two offline edits at the same revision, dependent operation
 * accidentally accepted after a conflict. Tier: unit, real in-memory SQLite, no waits. Standalone: 0.73s (2026-11-23).
 */
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { UmedaWork } from '../work';
import { runWorkStore, type WorkSqlDatabase } from '@cindy/maker-shared/work-store';
import { runWorkReplica, WORK_DATABASE_SCHEMA, type WorkEnvelope, type WorkFeed } from '@cindy/maker-shared/work-replication';
import { syncWork } from '@cindy/maker-shared/work-sync';
import type { WorkItem, WorkManagementRequest } from '@cindy/maker-shared/work-management';
import type { ObjectContext, RelayEnvironment } from '../runtime';

const databases: DatabaseSync[] = [];
function open() {
  const raw = new DatabaseSync(':memory:'); databases.push(raw); raw.exec('PRAGMA foreign_keys=ON;');
  let depth = 0;
  const db: WorkSqlDatabase = {
    prepare: sql => ({ get: (...p) => raw.prepare(sql).get(...p as never[]), all: (...p) => raw.prepare(sql).all(...p as never[]), run: (...p) => raw.prepare(sql).run(...p as never[]) }),
    transaction: fn => () => { if (depth) return fn(); raw.exec('BEGIN'); depth++; try { const value = fn(); raw.exec('COMMIT'); return value; } catch (error) { raw.exec('ROLLBACK'); throw error; } finally { depth--; } },
  };
  return { raw, db };
}
function setup() {
  const cloud = open();
  const context = { storage: { sql: { exec(sql: string, ...p: never[]) { const rows = cloud.raw.prepare(sql).all(...p); return { toArray: () => rows }; } }, transactionSync: <T,>(fn: () => T) => cloud.db.transaction(fn)() }, waitUntil: () => {} };
  const env = { UMEDA_RELAY: { idFromName: () => '', get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } } as RelayEnvironment;
  const worker = new UmedaWork(context as unknown as ObjectContext & typeof context, env);
  const http = async (path: string, body?: unknown) => { const result = await worker.fetch(new Request('https://relay.invalid' + path, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined })); return { status: result.status, body: await result.json() }; };
  let counter = 0;
  const replica = () => {
    const { db, raw } = open(); raw.exec(WORK_DATABASE_SCHEMA);
    const execute = (request: WorkManagementRequest, created_id = `item-${++counter}`) => db.transaction(() => {
      const input = { request, actor: { kind: 'user' as const }, created_id, now: ++counter };
      const result = runWorkStore(db, input); runWorkReplica(db, { operation: 'capture', input }); return result;
    })();
    const get = (id: string) => (runWorkStore(db, { request: { operation: 'get', id }, actor: { kind: 'user' }, created_id: 'read', now: 1 }).item as WorkItem);
    const sync = (request = http, current = () => true) => syncWork({ scope: 'synthetic-relay', replica: async input => runWorkReplica(db, input, runWorkStore), http: request, current, changed() {} });
    return { db, raw, execute, get, sync, status: () => runWorkReplica(db, { operation: 'status' }) };
  };
  return { cloud, worker, http, replica };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe('application business replication', () => {
  it('preserves original IDs/history, an atomic progress batch and lost-ack deduplication', async () => {
    const f = setup(), a = f.replica(), b = f.replica();
    a.execute({ operation: 'create', request_id: 'goal-create', kind: 'goal', title: 'Read' }, 'goal');
    a.execute({ operation: 'create', request_id: 'project-create', kind: 'project', title: 'Reader', goal_ids: ['goal'] }, 'project');
    a.execute({ operation: 'create', request_id: 'task-create', kind: 'task', title: 'Chapter', project_ids: ['project'] }, 'task');
    // Simulate the previous client version: only immutable business history exists.
    a.raw.exec('DELETE FROM umeda_work_outbox');
    await a.sync(); await b.sync();
    expect(b.get('task')).toEqual(a.get('task'));
    expect(b.raw.prepare('SELECT count(*) n FROM umeda_work_records').get()?.n).toBe(3);
    b.execute({ operation: 'update', request_id: 'delivery', summary: 'Chapter delivered', changes: [{ id: 'task', expected_revision: 1, status: 'done' }, { id: 'goal', expected_revision: 1, progress: { percent: 40, basis: 'First chapter finished' } }] });
    let lost = true;
    await expect(b.sync(async (path, body) => { const response = await f.http(path, body); if (body && lost) { lost = false; throw new Error('lost response'); } return response; })).rejects.toThrow('lost response');
    expect(b.status().queued).toBe(1);
    await b.sync(); await a.sync();
    expect(a.get('task')).toMatchObject({ revision: 2, status: 'done' });
    expect(a.get('goal').progress?.percent).toBe(40);
    expect(f.cloud.raw.prepare('SELECT count(*) n FROM work_commits').get()?.n).toBe(4);
    expect(b.status()).toMatchObject({ queued: 0, conflicts: [] });
    expect(a.raw.prepare("SELECT count(*) n FROM umeda_work_record_items WHERE request_id='delivery'").get()?.n).toBe(3);
  });

  it('blocks dependent drafts, sends unrelated work, and explicitly rebases local changes without replacing old receipts', async () => {
    const f = setup(), a = f.replica(), b = f.replica();
    a.execute({ operation: 'create', request_id: 'create', kind: 'task', title: 'Original' }, 'task'); await a.sync(); await b.sync();
    a.execute({ operation: 'update', request_id: 'remote-edit', summary: 'Remote title', changes: [{ id: 'task', expected_revision: 1, title: 'Remote' }] }); await a.sync();
    b.execute({ operation: 'update', request_id: 'offline-edit', summary: 'Local title', changes: [{ id: 'task', expected_revision: 1, title: 'Local' }] });
    b.execute({ operation: 'update', request_id: 'offline-followup', summary: 'Local followup', changes: [{ id: 'task', expected_revision: 2, status: 'done' }] });
    b.execute({ operation: 'create', request_id: 'independent', kind: 'goal', title: 'Independent' }, 'goal');
    const old = b.raw.prepare("SELECT data,result FROM umeda_work_records WHERE request_id='offline-edit'").get();
    await b.sync(); await a.sync();
    expect(b.get('task')).toMatchObject({ title: 'Local', status: 'done' });
    expect(a.get('task')).toMatchObject({ title: 'Remote', status: 'todo' });
    expect(a.get('goal').title).toBe('Independent');
    expect(b.status()).toMatchObject({ queued: 1, conflicts: [{ request_id: 'offline-edit' }] });
    const resolution = runWorkReplica(b.db, { operation: 'resolve', request_id: 'offline-edit', choice: 'local', nonce: 'rebased', now: 200, actor: { kind: 'agent_report', session_id: 'synthetic-agent', epoch: 0, agent_kind: 'codex' } }, runWorkStore);
    expect(runWorkReplica(b.db, { operation: 'resolve', request_id: 'offline-edit', choice: 'local', nonce: 'retry', now: 201 }, runWorkStore)).toEqual(resolution);
    expect(JSON.parse((b.raw.prepare("SELECT data FROM umeda_work_records WHERE request_id='rebased'").get() as { data: string }).data).actor.kind).toBe('agent_report');
    await b.sync(); await a.sync();
    expect(a.get('task')).toMatchObject({ title: 'Local', status: 'done', revision: 3 });
    expect(b.raw.prepare("SELECT data,result FROM umeda_work_records WHERE request_id='offline-edit'").get()).toEqual(old);
    expect(b.status()).toMatchObject({ queued: 0, conflicts: [] });
  });

  it('uses accepted journal associations when another device changes a project link, retaining the original local receipt', async () => {
    const f = setup(), a = f.replica(), b = f.replica();
    a.execute({ operation: 'create', request_id: 'g1', kind: 'goal', title: 'First' }, 'goal-1');
    a.execute({ operation: 'create', request_id: 'g2', kind: 'goal', title: 'Second' }, 'goal-2');
    a.execute({ operation: 'create', request_id: 'p', kind: 'project', title: 'Project', goal_ids: ['goal-1'] }, 'project');
    a.execute({ operation: 'create', request_id: 't', kind: 'task', title: 'Task', project_ids: ['project'] }, 'task');
    await a.sync(); await b.sync();
    b.execute({ operation: 'update', request_id: 'delivery', summary: 'Task delivered', changes: [{ id: 'task', expected_revision: 1, status: 'done' }] });
    const old = b.raw.prepare("SELECT data FROM umeda_work_records WHERE request_id='delivery'").get();
    a.execute({ operation: 'update', request_id: 'relink', summary: 'Relink project', changes: [{ id: 'project', expected_revision: 1, goal_ids: ['goal-2'] }] });
    await a.sync(); await b.sync(); await a.sync();
    const associations = (v: ReturnType<typeof f.replica>) => v.raw.prepare("SELECT item_id FROM umeda_work_record_items WHERE request_id='delivery' ORDER BY item_id").all();
    expect(associations(a)).toEqual(associations(b));
    expect(associations(b)).toEqual([{ item_id: 'goal-2' }, { item_id: 'project' }, { item_id: 'task' }]);
    expect(b.raw.prepare("SELECT data FROM umeda_work_records WHERE request_id='delivery'").get()).toEqual(old);
    const accepted = runWorkStore(b.db, { request: { operation: 'record', request_id: 'delivery' }, actor: { kind: 'user' }, created_id: 'read', now: 1 });
    expect(accepted.record).toMatchObject({ item_ids: ['goal-2', 'project', 'task'] });
  });

  it('uses the shared version only on explicit resolution and rejects changed ID retries', async () => {
    const f = setup(), a = f.replica(), b = f.replica();
    a.execute({ operation: 'create', request_id: 'create', kind: 'task', title: 'Original' }, 'task'); await a.sync(); await b.sync();
    a.execute({ operation: 'update', request_id: 'remote', summary: 'Remote', changes: [{ id: 'task', expected_revision: 1, title: 'Remote' }] }); await a.sync();
    b.execute({ operation: 'update', request_id: 'local', summary: 'Local', changes: [{ id: 'task', expected_revision: 1, title: 'Local' }] }); await b.sync();
    runWorkReplica(b.db, { operation: 'resolve', request_id: 'local', choice: 'remote', nonce: 'resolve', now: 2 }, runWorkStore);
    expect(b.get('task').title).toBe('Remote');
    const envelope = JSON.parse((f.cloud.raw.prepare("SELECT envelope FROM work_commits WHERE request_id='create'").get() as { envelope: string }).envelope) as WorkEnvelope;
    expect((await f.http('/api/work/commits', { ...envelope, created_id: 'different' })).status).toBe(409);
    expect((await f.http('/api/work/commits', { ...envelope, request: { ...envelope.request, title: 'different' } })).status).toBe(409);
    expect(b.raw.prepare("SELECT count(*) n FROM umeda_work_records WHERE request_id='local'").get()?.n).toBe(1);
  });

  it('fences stale owners, validates feed continuity and refuses silent route or cloud resets', async () => {
    const f = setup(), a = f.replica(), b = f.replica();
    a.execute({ operation: 'create', request_id: 'create', kind: 'task', title: 'Original' }, 'task'); await a.sync();
    let current = true;
    await expect(b.sync(async (path, body) => { const response = await f.http(path, body); current = false; return response; }, () => current)).rejects.toThrow('WORK_CONTEXT_CHANGED');
    expect(b.status().cursor).toBe(0);
    await b.sync();
    expect(() => runWorkReplica(b.db, { operation: 'bind', scope: 'different-relay' })).toThrow('WORK_SYNC_SCOPE_CHANGED');
    const feed = (await f.http('/api/work/changes?after=0')).body as WorkFeed;
    expect(() => runWorkReplica(b.db, { operation: 'apply', feed: { ...feed, epoch: 'reset', commits: [], cursor: 1 } })).toThrow('WORK_SYNC_EPOCH_CHANGED');
    const c = f.replica(); runWorkReplica(c.db, { operation: 'bind', scope: 'synthetic-relay' });
    expect(() => runWorkReplica(c.db, { operation: 'apply', feed: { ...feed, commits: [{ ...feed.commits[0], cursor: 2 }], cursor: 2 } })).toThrow('WORK_SYNC_INVALID_FEED');
    expect(c.status().cursor).toBe(0);
  });
});
