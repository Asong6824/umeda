import { DurableObject } from 'cloudflare:workers';
import { runWorkStore, type WorkSqlDatabase } from '@cindy/maker-shared/work-store';
import { WORK_SYNC_PREFIX, type WorkCommit, type WorkEnvelope } from '@cindy/maker-shared/work-replication';
import type { WorkProgressRecord } from '@cindy/maker-shared/work-management';
import type { ObjectContext, RelayEnvironment } from './runtime';
import { RelayError } from '../src/errors';
import { readJson } from './requestJson';

interface WorkContext extends ObjectContext {
  storage: ObjectContext['storage'] & {
    sql: { exec(sql: string, ...params: unknown[]): { toArray(): Record<string, unknown>[] } };
    transactionSync<T>(operation: () => T): T;
  };
}
const schema = [
  'CREATE TABLE IF NOT EXISTS umeda_work_items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,title TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL,revision INTEGER NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS umeda_work_records(sequence INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,data TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL)',
  'CREATE TABLE IF NOT EXISTS umeda_work_record_items(request_id TEXT NOT NULL REFERENCES umeda_work_records(request_id),item_id TEXT NOT NULL REFERENCES umeda_work_items(id),PRIMARY KEY(request_id,item_id))',
  'CREATE INDEX IF NOT EXISTS work_item_history ON umeda_work_record_items(item_id)',
  'CREATE TABLE IF NOT EXISTS umeda_work_confirmed_records(request_id TEXT PRIMARY KEY NOT NULL,data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS work_commits(cursor INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,envelope TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS work_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)',
];
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

/** One business coordinator. Its lifetime and data do not depend on execution sockets. */
export class UmedaWork extends DurableObject<RelayEnvironment> {
  private readonly db: WorkSqlDatabase;
  constructor(private readonly workContext: WorkContext, private readonly workEnv: RelayEnvironment) {
    super(workContext, workEnv);
    let depth = 0;
    this.db = {
      prepare: sql => ({
        get: (...p) => workContext.storage.sql.exec(sql, ...p).toArray()[0],
        all: (...p) => workContext.storage.sql.exec(sql, ...p).toArray(),
        run: (...p) => { workContext.storage.sql.exec(sql, ...p).toArray(); },
      }),
      transaction: operation => () => {
        if (depth) return operation();
        return workContext.storage.transactionSync(() => { depth++; try { return operation(); } finally { depth--; } });
      },
    };
    this.db.transaction(() => {
      for (const sql of schema) this.db.prepare(sql).run();
      this.db.prepare("INSERT OR IGNORE INTO work_metadata VALUES('epoch',?)").run(crypto.randomUUID());
    })();
  }
  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === `${WORK_SYNC_PREFIX}/commits` && request.method === 'POST') {
        const envelope = await readJson(request, 96 * 1024) as unknown as WorkEnvelope;
        if (envelope.version !== 1 || !['create', 'update'].includes(envelope.request?.operation)) return json({ error: 'WORK_INVALID_INPUT' }, 400);
        const value = this.db.transaction(() => {
          const result = runWorkStore(this.db, envelope);
          const id = String(result.request_id);
          const old = this.db.prepare('SELECT envelope FROM work_commits WHERE request_id=?').get(id) as { envelope: string } | undefined;
          if (old) {
            const original = JSON.parse(old.envelope) as WorkEnvelope;
            if (envelope.request.operation === 'create' && original.created_id !== envelope.created_id) throw new Error('WORK_REQUEST_REUSED');
          } else this.db.prepare('INSERT INTO work_commits(request_id,envelope) VALUES(?,?)').run(id, JSON.stringify(envelope));
          return { request_id: id, status: 'committed' };
        })();
        this.workContext.waitUntil(this.workEnv.UMEDA_RELAY.get(this.workEnv.UMEDA_RELAY.idFromName('private-relay-v1')).fetch(new Request('https://internal/internal/work-changed', { method: 'POST' })).catch(() => undefined));
        return json(value);
      }
      if (url.pathname === `${WORK_SYNC_PREFIX}/changes` && request.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) return json({ error: 'WORK_INVALID_INPUT' }, 400);
        const head = (this.db.prepare('SELECT COALESCE(max(cursor),0) head FROM work_commits').get() as { head: number }).head;
        if (after > head) return json({ error: 'WORK_SYNC_CURSOR_AHEAD' }, 409);
        const rows = this.db.prepare('SELECT c.cursor,c.envelope,r.fingerprint,r.data,r.result FROM work_commits c JOIN umeda_work_records r USING(request_id) WHERE c.cursor>? ORDER BY c.cursor LIMIT 21').all(after) as { cursor: number; envelope: string; fingerprint: string; data: string; result: string }[];
        const commits: WorkCommit[] = [];
        let bytes = 0;
        for (const row of rows.slice(0, 20)) {
          const commit = { cursor: row.cursor, envelope: JSON.parse(row.envelope), fingerprint: row.fingerprint, record: JSON.parse(row.data) as WorkProgressRecord, result: JSON.parse(row.result) };
          const size = new TextEncoder().encode(JSON.stringify(commit)).byteLength;
          if (commits.length && bytes + size > 1024 * 1024) break;
          commits.push(commit); bytes += size;
        }
        const epoch = (this.db.prepare("SELECT value FROM work_metadata WHERE key='epoch'").get() as { value: string }).value;
        return json({ epoch, commits, cursor: commits.at(-1)?.cursor ?? after, more: rows.length > commits.length });
      }
      return json({ error: 'WORK_NOT_FOUND' }, 404);
    } catch (error) {
      if (error instanceof RelayError) return json({ error: 'WORK_INVALID_INPUT' }, error.status);
      const code = error instanceof Error ? error.message : '';
      const expected = ['WORK_INVALID_INPUT', 'WORK_NOT_FOUND', 'WORK_VERSION_CONFLICT', 'WORK_REQUEST_REUSED', 'WORK_INVALID_RELATION'];
      return json({ error: expected.includes(code) ? code : 'WORK_SYNC_UNAVAILABLE' }, code === 'WORK_VERSION_CONFLICT' || code === 'WORK_REQUEST_REUSED' ? 409 : expected.includes(code) ? 400 : 503);
    }
  }
}
