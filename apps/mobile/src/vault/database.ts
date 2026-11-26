import * as SQLite from 'expo-sqlite';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { createLibraryStorage, LIBRARY_SCHEMA_2, LIBRARY_SCHEMA_3, contentHash } from '../../../../packages/kos-workbench/src/library/storage';
import { uniqueId } from '../../../../packages/kos-workbench/src/library/ports';

let database: Promise<SQLite.SQLiteDatabase> | undefined;
let writes: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const result = writes.catch(() => undefined).then(operation);
  writes = result;
  return result;
}
async function open() {
  return database ??= (async () => {
    const db = await SQLite.openDatabaseAsync('umeda-library-v1.sqlite');
    const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
    if ((row?.user_version ?? 0) > 3) throw new Error('UNSUPPORTED_LIBRARY_DATABASE');
    await db.execAsync('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    await db.withExclusiveTransactionAsync(async tx => {
      await tx.execAsync('CREATE TABLE IF NOT EXISTS library_values (scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(scope, key));');
      for (const sql of LIBRARY_SCHEMA_2) await tx.execAsync(sql);
      for (const sql of LIBRARY_SCHEMA_3) await tx.execAsync(sql);
      await tx.execAsync('PRAGMA user_version=3;');
    });
    return db;
  })().catch(error => { database = undefined; throw error; });
}

/** Lazy copy-forward, including tombstones. The old AsyncStorage is never erased. */
export function libraryStorage(scope: string, valid = () => true) {
  const legacyPrefix = `umeda.workbench.v1.${scope}.`;
  const root = new Directory(Paths.document, 'umeda-library', scope, 'content');
  const file = (hash: string) => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('INVALID_LIBRARY_CONTENT_HASH');
    return new File(root, hash);
  };
  return createLibraryStorage(scope, {
    async rows<T>(sql: string, params = []) { const db = await open(); return db.getAllAsync<T>(sql, ...params); },
    async legacy(key) {
      const db = await open();
      const row = await db.getFirstAsync<{ value: string | null }>('SELECT value FROM library_values WHERE scope=? AND key=?', scope, key);
      if (row) return row.value;
      return AsyncStorage.getItem(legacyPrefix + key);
    },
    async batch(statements, current) {
      const db = await open();
      await serialize(() => db.withExclusiveTransactionAsync(async tx => {
        if (!valid() || !current()) throw new Error('STALE_LIBRARY_SCOPE');
        for (const st of statements) await tx.runAsync(st.sql, ...(st.params ?? []));
        if (!valid() || !current()) throw new Error('STALE_LIBRARY_SCOPE');
      }));
    },
    async readBlob(hash) { const target = file(hash); return target.exists ? target.bytes() : null; },
    async writeBlob(hash, bytes) {
      if (!valid()) throw new Error('STALE_LIBRARY_SCOPE');
      const target = file(hash);
      if (target.exists) {
        if (contentHash(await target.bytes()) !== hash) throw new Error('LIBRARY_CONTENT_CORRUPT');
        return;
      }
      root.create({ intermediates: true, idempotent: true });
      const temporary = new File(root, 'pending-' + uniqueId());
      await temporary.write(bytes);
      if (contentHash(await temporary.bytes()) !== hash || !valid()) throw new Error('LIBRARY_CONTENT_WRITE_FAILED');
      await temporary.move(target);
    },
  });
}
