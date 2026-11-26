import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkItem, WorkManagementRequest } from '@cindy/maker-shared/work-management';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { runWorkManagementTransaction } from '../worker/opHandlers/workManagementTx';
import { runWorkReplica } from '@cindy/maker-shared/work-replication';
import { runWorkStore } from '@cindy/maker-shared/work-store';
import { tx } from '../worker/opHandlers/tx';

// Test value: story 8 and the explicit end-of-coding progress request. Production
// transaction + generated SQL must persist shared business facts atomically.
// Existing checkpoint tests only cover one execution Session, not business objects.
// Minimal failures: one stale revision in a batch; a lost receipt retried after a
// newer update; invalid progress without evidence. Tier: db (real SQLite/reopen).
// Standalone duration: 1.81s locally (2026-11-22).
describe('Umeda shared business progress', () => {
  let db: Database.Database, directory: string, counter: number;
  const actor = { session_id: 'codex', epoch: 0, agent_kind: 'codex' };
  const open = () => createBetterSqliteDatabase(path.join(directory, 'work.db'));
  const run = (request: WorkManagementRequest, source = actor) => tx(db, { name: 'umedaWork.execute', args: {
    request, actor: source, created_id: `item-${++counter}`, now: counter,
  } }) as Record<string, unknown>;
  const create = (kind: 'goal' | 'project' | 'task', title: string, refs = {}) =>
    (run({ operation: 'create', request_id: `create-${counter + 1}`, kind, title, ...refs }).items as WorkItem[])[0];
  const get = (id: string) => run({ operation: 'get', id });
  beforeEach(() => {
    directory = mkdtempSync(path.join(tmpdir(), 'umeda-business-')); counter = 0; db = open();
    db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT,cleared_at INTEGER); INSERT INTO sessions VALUES('codex','active',NULL),('claude','active',NULL)");
    db.exec(readFileSync(new URL('../../../../drizzle/0149_umeda_work_management.sql', import.meta.url), 'utf8'));
    db.exec(readFileSync(new URL('../../../../drizzle/0150_exotic_valeria_richards.sql', import.meta.url), 'utf8'));
    db.exec(readFileSync(new URL('../../../../drizzle/0151_vengeful_bulldozer.sql', import.meta.url), 'utf8'));
  });
  afterEach(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });

  it('updates tasks and goal progress together and records work in the linked project without completing it', () => {
    const goal = create('goal', 'Better reading'), project = create('project', 'Reader', { goal_ids: [goal.id] });
    const task = create('task', 'Fix return', { project_ids: [project.id] });
    const result = run({ operation: 'update', request_id: 'delivery', summary: 'Fixed return navigation', changes: [
      { id: task.id, expected_revision: 1, status: 'done' },
      { id: goal.id, expected_revision: 1, progress: { percent: 40, basis: 'Navigation milestone delivered; offline search remains' } },
    ], verification: [{ description: 'navigation checks', outcome: 'reported_passed', evidence: 'synthetic test run' }] });
    expect(result.recorded_item_ids).toEqual([goal.id, project.id, task.id].sort());
    expect(get(task.id).item).toMatchObject({ status: 'done', revision: 2 });
    expect(get(goal.id).item).toMatchObject({ status: 'doing', progress: { percent: 40 } });
    expect(run({ operation: 'list', kind: 'task', goal_id: goal.id }).items).toEqual([expect.objectContaining({ id: task.id })]);
    expect(get(project.id)).toMatchObject({ item: { status: 'doing', revision: 1 }, records: [expect.objectContaining({ request_id: 'delivery' }), expect.anything(), expect.anything()] });
    expect(run({ operation: 'record', request_id: 'delivery' }).record).toMatchObject({ actor: { kind: 'agent_report', agent_kind: 'codex' }, verification: [{ outcome: 'reported_passed' }] });
    expect(db.prepare('SELECT status FROM sessions WHERE id=?').get('codex')).toEqual({ status: 'active' });
  });

  it('rolls back the entire request on a stale version or invalid relationship', () => {
    const task = create('task', 'Implement'), goal = create('goal', 'Ship');
    expect(() => run({ operation: 'update', request_id: 'conflict', summary: 'done', changes: [
      { id: task.id, expected_revision: 1, status: 'done' }, { id: goal.id, expected_revision: 2, status: 'done' },
    ] })).toThrow('WORK_VERSION_CONFLICT');
    expect(get(task.id).item).toMatchObject({ status: 'todo', revision: 1 });
    expect(() => run({ operation: 'record', request_id: 'conflict' })).toThrow('WORK_NOT_FOUND');
    expect(() => run({ operation: 'update', request_id: 'bad-link', summary: 'link', changes: [
      { id: task.id, expected_revision: 1, project_ids: [goal.id] },
    ] })).toThrow('WORK_INVALID_RELATION');
    expect(get(task.id).item).toMatchObject({ project_ids: [], revision: 1 });
  });

  it('keeps immutable receipts across later edits and engine changes without repeating progress', () => {
    const task = create('task', 'Implement');
    const request: WorkManagementRequest = { operation: 'update', request_id: 'once', summary: 'done', changes: [{ id: task.id, expected_revision: 1, status: 'done' }] };
    const first = run(request);
    run({ operation: 'update', request_id: 'later', summary: 'Reopen after review', changes: [{ id: task.id, expected_revision: 2, status: 'doing' }] });
    expect(run(request, { session_id: 'claude', epoch: 0, agent_kind: 'claude-code' })).toEqual(first);
    expect(get(task.id).item).toMatchObject({ status: 'doing', revision: 3 });
    expect(() => run({ ...request, summary: 'different' })).toThrow('WORK_REQUEST_REUSED');
    const original = run({ operation: 'create', request_id: 'create-once', kind: 'task', title: 'Standalone' });
    expect(run({ operation: 'create', request_id: 'create-once', kind: 'task', title: 'Standalone' })).toEqual(original);
    expect(db.prepare('SELECT count(*) n FROM umeda_work_items').get()).toEqual({ n: 2 });
  });

  it('survives reopen and conversation clearing while rejecting old execution context', () => {
    const task = create('task', 'Not a conversation');
    db.prepare('UPDATE sessions SET cleared_at=10 WHERE id=?').run('codex');
    expect(() => run({ operation: 'update', request_id: 'stale-context', summary: 'done', changes: [{ id: task.id, expected_revision: 1, status: 'done' }] })).toThrow('WORK_CONTEXT_CHANGED');
    db.close(); db = open();
    expect(run({ operation: 'get', id: task.id }, { session_id: 'claude', epoch: 0, agent_kind: 'claude-code' }).item).toEqual(task);
    expect(run({ operation: 'get', id: task.id }, { ...actor, epoch: 10 }).item).toEqual(task);
    db.prepare('DELETE FROM sessions WHERE id=?').run('codex');
    expect(run({ operation: 'get', id: task.id }, { session_id: 'claude', epoch: 0, agent_kind: 'claude-code' }).item).toEqual(task);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  });

  it('pages summaries and journals, preserving descriptions during record-only updates', () => {
    const project = create('project', 'Literal % project');
    const task = create('task', 'Other', { project_ids: [project.id] });
    run({ operation: 'update', request_id: 'describe', summary: 'Describe', changes: [{ id: project.id, expected_revision: 1, description: 'Keep this' }] });
    let revision = 2;
    for (let n = 0; n < 6; n++) run({ operation: 'update', request_id: `note-${n}`, summary: `Milestone ${n}`, changes: [{ id: project.id, expected_revision: revision++ }] });
    expect(get(project.id).item).toMatchObject({ description: 'Keep this', revision });
    const page = get(project.id);
    expect(page.records).toHaveLength(5);
    expect(run({ operation: 'get', id: project.id, before_record: page.next_before_record as number }).records).toHaveLength(4);
    const first = run({ operation: 'list', limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(run({ operation: 'list', limit: 1, after: first.next_after as string }).next_after).toBeNull();
    expect(run({ operation: 'list', query: '%' }).items).toEqual([expect.objectContaining({ id: project.id })]);
    expect(run({ operation: 'list', project_id: project.id }).items).toEqual([expect.objectContaining({ id: task.id })]);
    expect((first.items as object[])[0]).not.toHaveProperty('description');
  });

  it('requires progress evidence and rejects fabricated verification and duplicate batch targets', () => {
    const goal = create('goal', 'Study');
    const invalid = [
      { changes: [{ id: goal.id, expected_revision: 1, progress: { percent: 30, basis: ' ' } }] },
      { changes: [{ id: goal.id, expected_revision: 1, progress: { percent: 101, basis: 'claim' } }] },
      { changes: [{ id: goal.id, expected_revision: 1 }], verification: [{ description: 'claim', outcome: 'host_verified' }] },
      { changes: [{ id: goal.id, expected_revision: 1 }, { id: goal.id, expected_revision: 1 }] },
    ];
    for (const patch of invalid) expect(() => run({ operation: 'update', request_id: 'invalid', summary: 'test', ...patch } as WorkManagementRequest)).toThrow('WORK_INVALID_INPUT');
    expect(get(goal.id).item).toMatchObject({ revision: 1, progress: null });
  });

  it('pages large UTF-8 summaries by bytes without dropping or repeating objects', () => {
    const goals = Array.from({ length: 12 }, (_, i) => create('goal', `Goal ${i}`));
    for (let offset = 0; offset < goals.length; offset += 6) run({ operation: 'update', request_id: `large-${offset}`, summary: 'Milestones',
      changes: goals.slice(offset, offset + 6).map(v => ({ id: v.id, expected_revision: 1, progress: { percent: 10, basis: '依据'.repeat(1000) } })) });
    let after: string | undefined;
    const seen: string[] = [];
    do {
      const page = run({ operation: 'list', kind: 'goal', limit: 50, ...(after ? { after } : {}) });
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(64 * 1024);
      seen.push(...(page.items as WorkItem[]).map(v => v.id));
      after = page.next_after as string | undefined;
    } while (after);
    expect(seen.sort()).toEqual(goals.map(v => v.id).sort());
  });

  it('fences Agent conflict resolution inside the transaction and retains its reported provenance on an idempotent retry', () => {
    const task = create('task', 'Original');
    db.prepare('INSERT INTO umeda_work_confirmed_items(id,data) VALUES(?,?)').run(task.id, JSON.stringify(task));
    db.prepare("UPDATE umeda_work_outbox SET state='confirmed'").run();
    run({ operation: 'update', request_id: 'offline', summary: 'Local draft', changes: [{ id: task.id, expected_revision: 1, title: 'Local' }] });
    db.prepare("UPDATE umeda_work_outbox SET state='conflict',error='WORK_VERSION_CONFLICT' WHERE request_id='offline'").run();
    db.prepare("UPDATE sessions SET cleared_at=1 WHERE id='codex'").run();
    expect(() => run({ operation: 'sync_resolve', request_id: 'offline', choice: 'remote' })).toThrow('WORK_CONTEXT_CHANGED');
    expect(JSON.parse((db.prepare('SELECT data FROM umeda_work_items WHERE id=?').get(task.id) as { data: string }).data).title).toBe('Local');
    expect(db.prepare("SELECT state FROM umeda_work_outbox WHERE request_id='offline'").get()).toEqual({ state: 'conflict' });
    const currentActor = { session_id: 'codex', epoch: 1, agent_kind: 'codex' };
    const resolved = run({ operation: 'sync_resolve', request_id: 'offline', choice: 'local' }, currentActor);
    expect(run({ operation: 'sync_resolve', request_id: 'offline', choice: 'local' }, currentActor)).toEqual(resolved);
    const record = run({ operation: 'record', request_id: String(resolved.request_id) }, currentActor).record;
    expect(record).toMatchObject({ actor: { kind: 'agent_report', epoch: 1 } });
  });

  it('executes the same transaction in the inline-worker fallback without module dependencies', () => {
    const fallback = runInNewContext(`(${runWorkManagementTransaction.toString()})`);
    const sharedStore = runInNewContext(`(${runWorkStore.toString()})`);
    const result = fallback(db, { request: { operation: 'create', request_id: 'inline', kind: 'task', title: 'Fallback task' }, actor, created_id: 'fallback-task', now: 1 }, sharedStore, runInNewContext(`(${runWorkReplica.toString()})`));
    expect(result.items).toEqual([expect.objectContaining({ id: 'fallback-task', title: 'Fallback task' })]);
    expect(get('fallback-task').item).toMatchObject({ kind: 'task', revision: 1 });
  });

  it('lets the human UI and an Agent maintain the same item without creating a synthetic execution session', () => {
    const count = db.prepare('SELECT count(*) n FROM sessions').get();
    const created = tx(db, { name: 'umedaWork.execute', args: { actor: { kind: 'user' }, request: { operation: 'create', request_id: 'ui-create', kind: 'task', title: 'Read a chapter' }, created_id: 'human-item', now: 1 } }) as { items: WorkItem[] };
    expect(created.items[0]).toMatchObject({ id: 'human-item', status: 'todo' });
    const written = run({ operation: 'update', request_id: 'agent-progress', summary: 'Chapter read', changes: [{ id: 'human-item', expected_revision: 1, status: 'done' }] });
    expect(written.items).toEqual([expect.objectContaining({ id: 'human-item', revision: 2, status: 'done' })]);
    expect(run({ operation: 'record', request_id: 'ui-create' }).record).toMatchObject({ actor: { kind: 'user' } });
    expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual(count);
  });
});
