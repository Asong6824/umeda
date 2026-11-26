import type { WorkManagementTransaction, WorkProgressRecord } from './workManagement';

export const WORK_SYNC_FEATURE = 'work-sync-v1';
export const WORK_SYNC_PREFIX = '/api/work';
export const WORK_CHANGE_NOTICE = 'umeda:work:changed';
export type WorkEnvelope = Omit<WorkManagementTransaction, 'request'> & { version: 1; request: Extract<WorkManagementTransaction['request'], { operation: 'create' | 'update' }> };
export interface WorkCommit {
  cursor: number;
  envelope: WorkEnvelope;
  fingerprint: string;
  record: WorkProgressRecord;
  result: Record<string, unknown>;
}
export interface WorkFeed { epoch: string; commits: WorkCommit[]; cursor: number; more: boolean }
export interface WorkSyncStatus {
  scope: string | null;
  cursor: number;
  queued: number;
  error: string | null;
  last_contact: number | null;
  conflict_count: number;
  conflicts: { request_id: string; error: string; summary: string }[];
}
export type WorkReplicaRequest =
  | { operation: 'bind'; scope: string }
  | { operation: 'pending' }
  | { operation: 'checkpoint' }
  | { operation: 'network'; error: string }
  | { operation: 'conflict'; request_id: string }
  | { operation: 'apply'; feed: WorkFeed }
  | { operation: 'reject'; request_id: string; error: string }
  | { operation: 'status' }
  | { operation: 'resolve'; request_id: string; choice: 'local' | 'remote'; nonce: string; now: number; actor?: WorkManagementTransaction['actor'] };

import type { WorkItem } from './workManagement';
import type { WorkSqlDatabase } from './workStore';

/** All replica state changes run in the same transaction as their local projection. */
export function runWorkReplica(db: WorkSqlDatabase, input: WorkReplicaRequest | { operation: 'capture'; input: WorkManagementTransaction }, executeStore?: (db: WorkSqlDatabase, input: WorkManagementTransaction) => Record<string, unknown>): Record<string, unknown> {
  type Row = { request_id: string; dependencies: string; state: string; local_order: number; error: string | null };
  const state = (key: string): string | null => (db.prepare('SELECT value FROM umeda_work_sync_state WHERE key=?').get(key) as { value: string } | undefined)?.value ?? null;
  const set = (key: string, value: string) => db.prepare('INSERT INTO umeda_work_sync_state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  const putItem = (value: WorkItem) => db.prepare('INSERT INTO umeda_work_items(id,kind,title,status,data,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,title=excluded.title,status=excluded.status,data=excluded.data,revision=excluded.revision,created_at=excluded.created_at,updated_at=excluded.updated_at').run(value.id, value.kind, value.title, value.status, JSON.stringify(value), value.revision, value.created_at, value.updated_at);
  function* pending(after = 0): Generator<Row> {
    while (true) {
      // Page only dependency IDs; never load every queued document body into JS.
      const rows = db.prepare(`SELECT o.request_id,o.state,o.local_order,o.error,
        (SELECT json_group_array(value) FROM (
          SELECT json_extract(value,'$.after.id') value FROM json_each(r.data,'$.changes')
          UNION SELECT ref.value FROM json_each(r.data,'$.changes') c,json_each(c.value,'$.after.project_ids') ref
          UNION SELECT ref.value FROM json_each(r.data,'$.changes') c,json_each(c.value,'$.after.goal_ids') ref
        )) dependencies
        FROM umeda_work_outbox o JOIN umeda_work_records r USING(request_id)
        WHERE o.state IN ('queued','conflict') AND o.local_order>? ORDER BY o.local_order LIMIT 100`).all(after) as Row[];
      for (const row of rows) yield row;
      if (rows.length < 100) return;
      after = rows[rows.length - 1].local_order;
    }
  }
  const record = (requestId: string) => JSON.parse((db.prepare('SELECT data FROM umeda_work_records WHERE request_id=?').get(requestId) as { data: string }).data) as WorkProgressRecord;
  const touched = (row: Row): string[] => JSON.parse(row.dependencies);
  return db.transaction(() => {
    if (input.operation === 'capture') {
      const r = input.input.request;
      if (r.operation !== 'create' && r.operation !== 'update') return {};
      const row = db.prepare('SELECT sequence,fingerprint,data FROM umeda_work_records WHERE request_id=?').get(r.request_id) as { sequence: number; fingerprint: string; data: string };
      const saved = JSON.parse(row.data) as WorkProgressRecord;
      const envelope: WorkEnvelope = { version: 1, request: JSON.parse(row.fingerprint), actor: saved.actor, now: saved.created_at,
        created_id: saved.operation === 'create' ? saved.changes[0].after.id : input.input.created_id };
      db.prepare("INSERT OR IGNORE INTO umeda_work_outbox(request_id,envelope,state,local_order) VALUES(?,?,'queued',?)").run(r.request_id, JSON.stringify(envelope), row.sequence);
      return {};
    }
    if (input.operation === 'bind') {
      if (!input.scope || input.scope.length > 2048) throw new Error('WORK_INVALID_INPUT');
      const scope = state('scope');
      if (scope && scope !== input.scope) throw new Error('WORK_SYNC_SCOPE_CHANGED');
      if (!scope) {
        // Seed original operation IDs and receipts, never manufacture new history.
        db.prepare(`INSERT OR IGNORE INTO umeda_work_outbox(request_id,envelope,state,local_order)
          SELECT request_id,json_object('version',1,'request',json(fingerprint),'actor',json_extract(data,'$.actor'),'now',created_at,
          'created_id',CASE WHEN json_extract(data,'$.operation')='create' THEN json_extract(data,'$.changes[0].after.id') ELSE request_id END),'queued',sequence FROM umeda_work_records`).run();
        set('scope', input.scope); set('cursor', '0');
      }
      return { scope: input.scope, cursor: Number(state('cursor') ?? 0) };
    }
    if (input.operation === 'network') {
      const code = ['WORK_SYNC_SCOPE_CHANGED', 'WORK_SYNC_EPOCH_CHANGED', 'WORK_SYNC_CURSOR_AHEAD'].includes(input.error) ? input.error : 'WORK_SYNC_UNAVAILABLE';
      set('error', code); return {};
    }
    if (input.operation === 'pending') {
      const blocked = new Set<string>();
      for (const row of pending()) {
        const ids = touched(row);
        if (row.state === 'conflict' || ids.some(id => blocked.has(id))) { ids.forEach(id => blocked.add(id)); continue; }
        const value = db.prepare('SELECT envelope FROM umeda_work_outbox WHERE request_id=?').get(row.request_id) as { envelope: string };
        return { envelope: JSON.parse(value.envelope) };
      }
      return {};
    }
    if (input.operation === 'reject') {
      if (!/^WORK_[A-Z_]+$/.test(input.error)) throw new Error('WORK_INVALID_INPUT');
      db.prepare("UPDATE umeda_work_outbox SET state='conflict',error=? WHERE request_id=? AND state='queued'").run(input.error, input.request_id);
      return {};
    }
    if (input.operation === 'apply') {
      const { feed } = input;
      if (!state('scope') || typeof feed.epoch !== 'string' || !feed.epoch || !Array.isArray(feed.commits) || feed.commits.length > 20) throw new Error('WORK_SYNC_INVALID_FEED');
      if (state('epoch') && state('epoch') !== feed.epoch) throw new Error('WORK_SYNC_EPOCH_CHANGED');
      let cursor = Number(state('cursor') ?? 0);
      for (const commit of feed.commits) {
        if (commit.cursor <= cursor) continue;
        if (commit.cursor !== cursor + 1 || commit.record.request_id !== commit.envelope.request.request_id) throw new Error('WORK_SYNC_INVALID_FEED');
        const local = db.prepare('SELECT fingerprint FROM umeda_work_records WHERE request_id=?').get(commit.record.request_id) as { fingerprint: string } | undefined;
        if (local && local.fingerprint !== commit.fingerprint) throw new Error('WORK_REQUEST_REUSED');
        db.prepare("UPDATE umeda_work_outbox SET state='confirmed',error=NULL WHERE request_id=?").run(commit.record.request_id);
        for (const change of commit.record.changes) {
          db.prepare('INSERT INTO umeda_work_confirmed_items(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(change.after.id, JSON.stringify(change.after));
          const hasDraft = !!db.prepare("SELECT 1 FROM umeda_work_outbox o JOIN umeda_work_records r USING(request_id) JOIN json_each(r.data,'$.changes') c WHERE o.state IN ('queued','conflict') AND json_extract(c.value,'$.after.id')=? LIMIT 1").get(change.after.id);
          if (!hasDraft) putItem(change.after);
        }
        db.prepare('INSERT INTO umeda_work_confirmed_records(request_id,data) VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET data=excluded.data').run(commit.record.request_id, JSON.stringify(commit.record));
        if (!local) {
          db.prepare('INSERT INTO umeda_work_records(request_id,fingerprint,data,result,created_at) VALUES(?,?,?,?,?)').run(commit.record.request_id, commit.fingerprint, JSON.stringify(commit.record), JSON.stringify(commit.result), commit.record.created_at);
        }
        // Associations are a projection of the accepted journal, not the old local guess.
        db.prepare('DELETE FROM umeda_work_record_items WHERE request_id=?').run(commit.record.request_id);
        for (const id of commit.record.item_ids) db.prepare('INSERT OR IGNORE INTO umeda_work_record_items(request_id,item_id) VALUES(?,?)').run(commit.record.request_id, id);
        cursor = commit.cursor;
      }
      if (cursor !== feed.cursor) throw new Error('WORK_SYNC_INVALID_FEED');
      set('epoch', feed.epoch); set('cursor', String(cursor)); set('error', ''); set('last_contact', String(Date.now()));
      return { cursor };
    }
    if (input.operation === 'resolve') {
      const receipt = state(`resolution:${input.request_id}`);
      if (receipt) {
        const previous = JSON.parse(receipt) as { choice: string };
        if (previous.choice !== input.choice) throw new Error('WORK_REQUEST_REUSED');
        return previous;
      }
      let first: Row | undefined;
      for (const row of pending()) if (row.request_id === input.request_id && row.state === 'conflict') { first = row; break; }
      if (!first) throw new Error('WORK_NOT_FOUND');
      const affected = new Set(touched(first)), discarded: Row[] = [];
      for (const row of pending(first.local_order - 1)) if (row.local_order >= first.local_order && touched(row).some(id => affected.has(id))) {
        touched(row).forEach(id => affected.add(id)); discarded.push(row);
      }
      const drafts = new Map<string, WorkItem>();
      for (const row of discarded) for (const change of record(row.request_id).changes) {
        const local = db.prepare('SELECT data FROM umeda_work_items WHERE id=?').get(change.after.id) as { data: string };
        drafts.set(change.after.id, JSON.parse(local.data));
      }
      if (drafts.size > 20) throw new Error('WORK_SYNC_RESOLUTION_TOO_LARGE');
      const canonical = new Map<string, WorkItem>();
      // Never erase an uncommitted create. Its immutable draft remains available.
      for (const id of drafts.keys()) {
        const remote = db.prepare('SELECT data FROM umeda_work_confirmed_items WHERE id=?').get(id) as { data: string } | undefined;
        if (!remote) throw new Error('WORK_SYNC_LOCAL_ONLY_DRAFT');
        canonical.set(id, JSON.parse(remote.data));
      }
      for (const remote of canonical.values()) putItem(remote);
      for (const row of discarded) db.prepare("UPDATE umeda_work_outbox SET state='resolved',error=NULL WHERE request_id=?").run(row.request_id);
      if (input.choice === 'local') {
        if (!executeStore) throw new Error('WORK_SYNC_REQUIRES_REBASE');
        const transaction: WorkManagementTransaction = { actor: input.actor ?? { kind: 'user' }, now: input.now, created_id: input.nonce,
          request: { operation: 'update', request_id: input.nonce, summary: record(first.request_id).summary,
            changes: [...drafts.values()].map(value => ({ id: value.id, expected_revision: canonical.get(value.id)!.revision,
              title: value.title, description: value.description, status: value.status, project_ids: value.project_ids, goal_ids: value.goal_ids, progress: value.progress })) } };
        executeStore(db, transaction);
        runWorkReplica(db, { operation: 'capture', input: transaction });
      }
      const result = { resolved: discarded.map(r => r.request_id), choice: input.choice, ...(input.choice === 'local' ? { request_id: input.nonce } : {}) };
      set(`resolution:${input.request_id}`, JSON.stringify(result));
      return result;
    }
    if (input.operation === 'conflict') {
      if (!db.prepare("SELECT 1 FROM umeda_work_outbox WHERE request_id=? AND state='conflict'").get(input.request_id)) throw new Error('WORK_NOT_FOUND');
      const value = record(input.request_id);
      return { record: value,
        remote: value.changes.flatMap(c => { const v = db.prepare('SELECT data FROM umeda_work_confirmed_items WHERE id=?').get(c.after.id) as { data: string } | undefined; return v ? [JSON.parse(v.data)] : []; }),
        local: value.changes.map(c => { const v = db.prepare('SELECT data FROM umeda_work_items WHERE id=?').get(c.after.id) as { data: string }; return JSON.parse(v.data); }) };
    }
    if (input.operation === 'checkpoint') return { scope: state('scope'), cursor: Number(state('cursor') ?? 0) };
    const counts = db.prepare("SELECT state,count(*) count FROM umeda_work_outbox WHERE state IN ('queued','conflict') GROUP BY state").all() as { state: string; count: number }[];
    const conflicts = db.prepare("SELECT o.request_id,o.error,json_extract(r.data,'$.summary') summary FROM umeda_work_outbox o JOIN umeda_work_records r USING(request_id) WHERE o.state='conflict' ORDER BY o.local_order LIMIT 20").all();
    return { scope: state('scope'), cursor: Number(state('cursor') ?? 0), queued: counts.find(r => r.state === 'queued')?.count ?? 0,
      error: state('error') || null, last_contact: state('last_contact') ? Number(state('last_contact')) : null,
      conflict_count: counts.find(r => r.state === 'conflict')?.count ?? 0, conflicts };

  })();
}

/** New databases only; desktop upgrades use generated append-only migrations. */
export const WORK_DATABASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS umeda_work_items(id TEXT PRIMARY KEY NOT NULL,kind TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS umeda_work_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,request_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,data TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS umeda_work_record_items(request_id TEXT NOT NULL REFERENCES umeda_work_records(request_id),item_id TEXT NOT NULL REFERENCES umeda_work_items(id),PRIMARY KEY(request_id,item_id));
CREATE INDEX IF NOT EXISTS umeda_work_kind_idx ON umeda_work_items(kind,id);
CREATE INDEX IF NOT EXISTS umeda_work_record_item_idx ON umeda_work_record_items(item_id);
CREATE TABLE IF NOT EXISTS umeda_work_sync_state(key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS umeda_work_outbox(request_id TEXT PRIMARY KEY NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,local_order INTEGER NOT NULL,error TEXT);
CREATE INDEX IF NOT EXISTS umeda_work_outbox_order_idx ON umeda_work_outbox(state,local_order);
CREATE TABLE IF NOT EXISTS umeda_work_confirmed_items(id TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS umeda_work_confirmed_records(request_id TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL);
`;

export interface WorkConflict { record: WorkProgressRecord; remote: WorkItem[]; local: WorkItem[] }
