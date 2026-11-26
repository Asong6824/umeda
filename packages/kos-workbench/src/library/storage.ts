import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { encodeBase64Url } from '@cindy/device-link';
import { encodeText, fromBase64 } from './encoding';
import type { Catalog, PendingEdit, PendingMove, StorageReport, BookIndex } from './model';

export interface Statement { sql: string; params?: Array<string | number | null> }
export interface StoragePorts {
  rows<T>(sql: string, params?: Statement['params']): Promise<T[]>;
  batch(statements: Statement[], current: () => boolean): Promise<void>;
  readBlob(hash: string): Promise<Uint8Array | null>;
  writeBlob(hash: string, bytes: Uint8Array): Promise<void>;
  legacy(key: string): Promise<string | null>;
}
export const LIBRARY_SCHEMA_2 = [
  'CREATE TABLE IF NOT EXISTS library_kv (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(scope,key))',
  'CREATE TABLE IF NOT EXISTS library_content (scope TEXT NOT NULL, key TEXT NOT NULL, hash TEXT, kind TEXT NOT NULL, PRIMARY KEY(scope,key))',
  'CREATE TABLE IF NOT EXISTS library_catalogs (scope TEXT NOT NULL, key TEXT NOT NULL, header TEXT NOT NULL, PRIMARY KEY(scope,key))',
  'CREATE TABLE IF NOT EXISTS library_documents (scope TEXT NOT NULL, key TEXT NOT NULL, vault TEXT NOT NULL, path TEXT NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(scope,key,vault,path))',
  'CREATE TABLE IF NOT EXISTS library_queues (scope TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(scope,key))',
  'CREATE TABLE IF NOT EXISTS library_outbox (scope TEXT NOT NULL, key TEXT NOT NULL, position INTEGER NOT NULL, id TEXT NOT NULL, vault TEXT NOT NULL, path TEXT NOT NULL, base_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, content_hash TEXT NOT NULL, PRIMARY KEY(scope,key,position))',
  'CREATE TABLE IF NOT EXISTS library_search (scope TEXT NOT NULL, key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(scope,key))',
  "CREATE VIRTUAL TABLE IF NOT EXISTS library_fts USING fts5(scope UNINDEXED, key UNINDEXED, body, tokenize='trigram')",
];
// Append-only migration. Earlier metadata and legacy payloads remain readable.
export const LIBRARY_SCHEMA_3 = [
  'CREATE TABLE IF NOT EXISTS library_move_queues (scope TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY(scope,key))',
  'CREATE TABLE IF NOT EXISTS library_moves (scope TEXT NOT NULL, key TEXT NOT NULL, position INTEGER NOT NULL, operation TEXT NOT NULL, PRIMARY KEY(scope,key,position))',
  'CREATE TABLE IF NOT EXISTS library_blob_sizes (scope TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(scope,hash))',
  'CREATE TABLE IF NOT EXISTS library_book_parts (scope TEXT NOT NULL, key TEXT NOT NULL, identity TEXT NOT NULL, position INTEGER NOT NULL, metadata TEXT NOT NULL, PRIMARY KEY(scope,key,identity,position))',
];
export const contentHash = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
function decodeUtf8(bytes: Uint8Array): string {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return decodeURIComponent(Array.from(bytes, byte => '%' + byte.toString(16).padStart(2, '0')).join(''));
}
export const base64 = (bytes: Uint8Array) => { const value = encodeBase64Url(bytes).replace(/-/g, '+').replace(/_/g, '/'); return value.padEnd(Math.ceil(value.length / 4) * 4, '='); };
const isText = (key: string) => /:text:[^:]+:[a-f0-9]{64}$/.test(key) || /:extracted:[^:]+:[a-f0-9]{64}:\d+$/.test(key);
const isBinary = (key: string) => /:binary:[a-f0-9]{64}:\d+$/.test(key);

/** File bytes precede the one metadata transaction. Orphans are retained, never treated as commits.
 * Old KV/AsyncStorage remains a read-only source. This repository never deletes content files.
 */
export function createLibraryStorage(scope: string, io: StoragePorts) {
  let tail: Promise<unknown> = Promise.resolve();
  function serial<T>(run: () => Promise<T>) { const result = tail.catch(() => undefined).then(run); tail = result; return result; }
  const rows = <T>(sql: string, params: Statement['params'] = []) => io.rows<T>(sql, params);
  const blob = async (bytes: Uint8Array) => {
    const hash = contentHash(bytes); await io.writeBlob(hash, bytes);
    const saved = await io.readBlob(hash);
    if (!saved || contentHash(saved) !== hash) throw new Error('LIBRARY_CONTENT_WRITE_FAILED');
    return hash;
  };
  async function read(hash: string) {
    const bytes = await io.readBlob(hash);
    if (!bytes || contentHash(bytes) !== hash) throw new Error('LIBRARY_CONTENT_UNAVAILABLE');
    return bytes;
  }
  async function prepare(key: string, value: string | null): Promise<Statement[]> {
    const params = [scope, key];
    if (key.endsWith(':book-indexes') && value !== null) {
      const indexes = JSON.parse(value) as Record<string, BookIndex>, header: Record<string, { count: number; complete: boolean; bytes: number }> = {}, statements: Statement[] = [];
      for (const [identity, index] of Object.entries(indexes)) {
        if (!Array.isArray(index.parts)) throw new Error('INVALID_BOOK_INDEX');
        header[identity] = { count: index.parts.length, complete: index.complete, bytes: index.bytes };
        const [previous] = await rows<{ count: number }>('SELECT COUNT(*) AS count FROM library_book_parts WHERE scope=? AND key=? AND identity=?', [...params, identity]);
        const count = previous?.count ?? 0;
        if (count > index.parts.length) throw new Error('BOOK_INDEX_MISMATCH');
        if (count < index.parts.length) statements.push({ sql: 'INSERT INTO library_book_parts(scope,key,identity,position,metadata) SELECT ?,?,?,CAST(key AS INTEGER)+?,value FROM json_each(?)', params: [...params, identity, count, JSON.stringify(index.parts.slice(count))] });
      }
      statements.push({ sql: 'INSERT OR REPLACE INTO library_kv(scope,key,value) VALUES (?,?,?)', params: [...params, JSON.stringify({ bookIndexFormat: 1, indexes: header })] });
      return statements;
    }
    if ((isText(key) || isBinary(key)) && value !== null) {
      const parsed = JSON.parse(value);
      if (typeof parsed !== 'string') throw new Error('INVALID_LIBRARY_CONTENT');
      const hash = await blob(isBinary(key) ? fromBase64(parsed) : encodeText(parsed));
      const st: Statement[] = [{ sql: 'INSERT OR REPLACE INTO library_content(scope,key,hash,kind) VALUES (?,?,?,?)', params: [...params, hash, isBinary(key) ? 'binary' : 'text'] }];
      st.push({ sql: 'INSERT OR REPLACE INTO library_blob_sizes(scope,hash,bytes) VALUES (?,?,?)', params: [scope, hash, isBinary(key) ? fromBase64(parsed).length : encodeText(parsed).length] });
      if (isText(key)) st.push(
        { sql: 'INSERT OR REPLACE INTO library_search(scope,key,body) VALUES (?,?,?)', params: [...params, parsed] },
        { sql: 'DELETE FROM library_fts WHERE scope=? AND key=?', params },
        { sql: 'INSERT INTO library_fts(scope,key,body) VALUES (?,?,?)', params: [...params, parsed] },
      );
      return st;
    }
    if (key.endsWith(':catalog') && value !== null) {
      const catalog = JSON.parse(value) as Catalog;
      if (!Array.isArray(catalog.vaults) || !catalog.files || typeof catalog.files !== 'object') throw new Error('INVALID_LIBRARY_CATALOG');
      const { files, ...header } = catalog;
      return [
        { sql: 'INSERT OR REPLACE INTO library_catalogs(scope,key,header) VALUES (?,?,?)', params: [...params, JSON.stringify(header)] },
        { sql: 'DELETE FROM library_documents WHERE scope=? AND key=?', params },
        { sql: "INSERT INTO library_documents(scope,key,vault,path,metadata) SELECT ?,?,v.key,json_extract(f.value,'$.path'),f.value FROM json_each(?) v, json_each(v.value) f", params: [...params, JSON.stringify(files)] },
      ];
    }
    if (key.endsWith(':pending') && value !== null) {
      const pending = JSON.parse(value) as PendingEdit[];
      if (!Array.isArray(pending)) throw new Error('INVALID_LIBRARY_QUEUE');
      const entries = [];
      for (const edit of pending) {
        if (typeof edit.text !== 'string') throw new Error('INVALID_LIBRARY_QUEUE');
        entries.push({ ...edit, text: undefined, hash: await blob(encodeText(edit.text)), bytes: encodeText(edit.text).length });
      }
      return [
        { sql: 'INSERT OR IGNORE INTO library_queues(scope,key) VALUES (?,?)', params },
        { sql: 'DELETE FROM library_outbox WHERE scope=? AND key=?', params },
        { sql: "INSERT INTO library_outbox(scope,key,position,id,vault,path,base_revision,created_at,content_hash) SELECT ?,?,CAST(e.key AS INTEGER),json_extract(e.value,'$.id'),json_extract(e.value,'$.vaultId'),json_extract(e.value,'$.path'),json_extract(e.value,'$.baseRevision'),json_extract(e.value,'$.createdAt'),json_extract(e.value,'$.hash') FROM json_each(?) e", params: [...params, JSON.stringify(entries)] },
        { sql: "INSERT OR REPLACE INTO library_blob_sizes(scope,hash,bytes) SELECT ?,json_extract(value,'$.hash'),json_extract(value,'$.bytes') FROM json_each(?)", params: [scope, JSON.stringify(entries)] },
      ];
    }
    if (key.endsWith(':moves') && value !== null) {
      const operations = JSON.parse(value) as PendingMove[];
      if (!Array.isArray(operations)) throw new Error('INVALID_LIBRARY_MOVES');
      return [
        { sql: 'INSERT OR IGNORE INTO library_move_queues(scope,key) VALUES (?,?)', params },
        { sql: 'DELETE FROM library_moves WHERE scope=? AND key=?', params },
        { sql: 'INSERT INTO library_moves(scope,key,position,operation) SELECT ?,?,CAST(key AS INTEGER),value FROM json_each(?)', params: [...params, value] },
      ];
    }
    // NULL is an explicit tombstone; old content must never resurrect after a removal.
    const st: Statement[] = [{ sql: 'INSERT OR REPLACE INTO library_kv(scope,key,value) VALUES (?,?,?)', params: [...params, value] }];
    if (value === null && (isText(key) || isBinary(key))) st.push(
      { sql: 'INSERT OR REPLACE INTO library_content(scope,key,hash,kind) VALUES (?,?,NULL,?)', params: [...params, 'deleted'] },
      { sql: 'DELETE FROM library_search WHERE scope=? AND key=?', params },
      { sql: 'DELETE FROM library_fts WHERE scope=? AND key=?', params },
    );
    return st;
  }
  async function commit(entries: Array<{ key: string; value: string | null }>, current = () => true) {
    return serial(async () => {
      if (!current()) throw new Error('STALE_LIBRARY_SCOPE');
      const statements: Statement[] = [];
      for (const entry of entries) statements.push(...await prepare(entry.key, entry.value));
      if (!current()) throw new Error('STALE_LIBRARY_SCOPE');
      await io.batch(statements, current);
    });
  }
  return {
    commit,
    set: (key: string, value: string | null) => commit([{ key, value }]),
    async get(key: string): Promise<string | null> {
      // Serialize reads with writes so a read cannot observe half a transaction on native drivers.
      return serial(async () => {
        const params = [scope, key];
        if (isText(key) || isBinary(key)) {
          const [found] = await rows<{ hash: string | null; kind: string; bytes: number | null }>('SELECT c.hash,c.kind,b.bytes FROM library_content c LEFT JOIN library_blob_sizes b ON b.scope=c.scope AND b.hash=c.hash WHERE c.scope=? AND c.key=?', params);
          if (found) {
            if (found.hash === null) return null;
            const bytes = await read(found.hash);
            if (found.bytes === null) await io.batch([{ sql: 'INSERT OR IGNORE INTO library_blob_sizes(scope,hash,bytes) VALUES (?,?,?)', params: [scope, found.hash, bytes.length] }], () => true);
            return JSON.stringify(found.kind === 'binary' ? base64(bytes) : decodeUtf8(bytes));
          }
        }
        if (key.endsWith(':catalog')) {
          const [found] = await rows<{ header: string }>('SELECT header FROM library_catalogs WHERE scope=? AND key=?', params);
          if (found) {
            const files: Catalog['files'] = Object.create(null);
            for (let offset = 0; ; offset += 500) {
              const page = await rows<{ vault: string; metadata: string }>('SELECT vault,metadata FROM library_documents WHERE scope=? AND key=? ORDER BY vault,path LIMIT 500 OFFSET ?', [...params, offset]);
              for (const row of page) (files[row.vault] ??= []).push(JSON.parse(row.metadata));
              if (page.length < 500) break;
            }
            const header = JSON.parse(found.header) as Omit<Catalog, 'files'>;
            for (const vault of header.vaults) files[vault.id] ??= [];
            return JSON.stringify({ ...header, files });
          }
        }
        if (key.endsWith(':pending') && (await rows('SELECT key FROM library_queues WHERE scope=? AND key=?', params)).length) {
          const pending = [];
          for (const e of await rows<{ id: string; vault: string; path: string; base_revision: number; created_at: number; content_hash: string }>('SELECT * FROM library_outbox WHERE scope=? AND key=? ORDER BY position', params)) pending.push({ id: e.id, vaultId: e.vault, path: e.path, baseRevision: e.base_revision, createdAt: e.created_at, text: decodeUtf8(await read(e.content_hash)) });
          return JSON.stringify(pending);
        }
        if (key.endsWith(':moves') && (await rows('SELECT key FROM library_move_queues WHERE scope=? AND key=?', params)).length) {
          const moves = [];
          for (let offset = 0; ; offset += 500) {
            const page = await rows<{ operation: string }>('SELECT operation FROM library_moves WHERE scope=? AND key=? ORDER BY position LIMIT 500 OFFSET ?', [...params, offset]);
            moves.push(...page.map(row => JSON.parse(row.operation)));
            if (page.length < 500) break;
          }
          return JSON.stringify(moves);
        }
        const [found] = await rows<{ value: string | null }>('SELECT value FROM library_kv WHERE scope=? AND key=?', params);
        if (found?.value && key.endsWith(':book-indexes')) {
          const header = JSON.parse(found.value);
          if (header.bookIndexFormat === 1) {
            const indexes: Record<string, BookIndex> = {};
            for (const [identity, summary] of Object.entries(header.indexes) as Array<[string, { count: number; complete: boolean; bytes: number }]>) {
              const parts: BookIndex['parts'] = [];
              for (let offset = 0; offset < summary.count; offset += 500) {
                const page = await rows<{ metadata: string }>('SELECT metadata FROM library_book_parts WHERE scope=? AND key=? AND identity=? ORDER BY position LIMIT ? OFFSET ?', [...params, identity, Math.min(500, summary.count - offset), offset]);
                parts.push(...page.map(row => JSON.parse(row.metadata)));
                if (!page.length) break;
              }
              if (parts.length !== summary.count) throw new Error('BOOK_INDEX_INCOMPLETE');
              indexes[identity] = { parts, complete: summary.complete, bytes: summary.bytes };
            }
            return JSON.stringify(indexes);
          }
        }
        const value = found ? found.value : await io.legacy(key);
        // Copy-forward only after new bytes are verified. Failed conversion leaves the source intact.
        const specialized = isText(key) || isBinary(key) || key.endsWith(':catalog') || key.endsWith(':pending') || key.endsWith(':moves');
        if (specialized || !found) await io.batch(await prepare(key, value), () => true);
        return value;
      });
    },
    async report(namespace: string, pinnedKeys: string[]): Promise<StorageReport> {
      return serial(async () => {
        // Only verified, registered objects count. No directory walk, read or deletion of user files.
        const [report] = await rows<StorageReport>(`WITH cache AS (SELECT DISTINCT hash FROM library_content WHERE scope=? AND substr(key,1,length(?))=? AND hash IS NOT NULL),
          pending AS (SELECT DISTINCT content_hash AS hash FROM library_outbox WHERE scope=? AND substr(key,1,length(?))=?),
          pinned AS (SELECT DISTINCT hash FROM library_content WHERE scope=? AND key IN (SELECT value FROM json_each(?)) AND hash IS NOT NULL)
          SELECT COALESCE(SUM(CASE WHEN hash IN cache THEN bytes ELSE 0 END),0) AS cacheBytes,
          COALESCE(SUM(CASE WHEN hash IN pending THEN bytes ELSE 0 END),0) AS pendingBytes,
          COALESCE(SUM(CASE WHEN hash IN pinned THEN bytes ELSE 0 END),0) AS pinnedBytes,
          COALESCE(SUM(CASE WHEN hash IN cache AND hash NOT IN pending AND hash NOT IN pinned THEN bytes ELSE 0 END),0) AS cacheOnlyBytes,
          COUNT(*) AS objects FROM library_blob_sizes WHERE scope=? AND (hash IN cache OR hash IN pending)`,
        [scope, namespace, namespace, scope, namespace, namespace, scope, JSON.stringify(pinnedKeys), scope]);
        return report;
      });
    },
    async search(keys: string[], query: string): Promise<{ hits: Array<{ key: string; snippet: string }>; covered: number; coveredKeys: string[] }> {
      await tail.catch(() => undefined);
      const term = query.trim().toLowerCase();
      if (term.length > 200 || keys.length > 50000) throw new Error('INVALID_LIBRARY_SEARCH');
      const coveredKeys: string[] = [];
      for (let offset = 0; ; offset += 500) {
        const page = await rows<{ key: string }>('SELECT k.value AS key FROM json_each(?) k WHERE EXISTS (SELECT 1 FROM library_search s WHERE s.scope=? AND s.key=k.value) LIMIT 500 OFFSET ?', [JSON.stringify(keys), scope, offset]);
        coveredKeys.push(...page.map(row => row.key));
        if (page.length < 500) break;
      }
      if (!term) return { hits: [], covered: coveredKeys.length, coveredKeys };
      // Trigrams accelerate longer literals; 1–2 character CJK queries deliberately use substring scan.
      const useFts = [...term].length >= 3;
      const result = await rows<{ key: string; body: string }>(useFts
        ? 'SELECT s.key,s.body FROM library_fts s WHERE library_fts MATCH ? AND s.scope=? AND s.key IN (SELECT value FROM json_each(?)) LIMIT 201'
        : 'SELECT key,body FROM library_search WHERE scope=? AND key IN (SELECT value FROM json_each(?)) AND instr(lower(body),?)>0 LIMIT 201',
      useFts ? ['"' + term.replace(/"/g, '""') + '"', scope, JSON.stringify(keys)] : [scope, JSON.stringify(keys), term]);
      return { covered: coveredKeys.length, coveredKeys, hits: result.map(row => { const at = row.body.toLowerCase().indexOf(term); return { key: row.key, snippet: row.body.slice(Math.max(0, at - 50), Math.max(0, at - 50) + 190) }; }) };
    },
  };
}
