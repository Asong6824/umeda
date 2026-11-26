/** Explicit integration tier: production mobile adapter + real SQLite, synthetic legacy data.
 * Checks copy-forward, durable reopen, scope isolation, tombstones and transaction rollback.
 * Does not substitute for testing Expo's native driver on an installed iPhone build.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'umeda-library-sqlite-'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url), output = path.join(root, 'adapter.cjs');
globalThis.__UMEDA_QA_LEGACY__ = new Map();
try {
  const previous = new DatabaseSync(path.join(root,'umeda-library-v1.sqlite'));
  previous.exec('CREATE TABLE library_values(scope TEXT NOT NULL,key TEXT NOT NULL,value TEXT,PRIMARY KEY(scope,key)); PRAGMA user_version=1');
  const oldQueue=[{id:'legacy-operation',vaultId:'notes',path:'old.md',baseRevision:1,createdAt:1,text:'old unsynced edit'}];
  previous.prepare('INSERT INTO library_values VALUES(?,?,?)').run('scope-a','scope-a:pending',JSON.stringify(oldQueue));previous.close();
  await build({ entryPoints: [path.join(repo, 'apps/mobile/src/vault/database.ts')], outfile: output, platform: 'node', format: 'cjs', bundle: true, plugins: [{ name: 'qa-native-ports', setup(builder) {
    builder.onResolve({ filter: /^(expo-sqlite|expo-file-system|@react-native-async-storage\/async-storage)$/ }, args => ({ path: args.path, namespace: 'qa-native' }));
    builder.onLoad({ filter: /.*/, namespace: 'qa-native' }, args => ({ contents: args.path === 'expo-sqlite' ? `
      import { DatabaseSync } from 'node:sqlite';
      export async function openDatabaseAsync(name) {
        const native = new DatabaseSync(${JSON.stringify(root)} + '/' + name);
        globalThis.__UMEDA_QA_DB__ = native;
        const adapter = {
          async getFirstAsync(sql,...params) { return native.prepare(sql).get(...params) ?? null; },
          async getAllAsync(sql,...params) { return native.prepare(sql).all(...params); },
          async runAsync(sql,...params) { return native.prepare(sql).run(...params); },
          async execAsync(sql) { native.exec(sql); },
          async withExclusiveTransactionAsync(run) {
            native.exec('BEGIN IMMEDIATE');
            try { await run(adapter); native.exec('COMMIT'); }
            catch(error) { native.exec('ROLLBACK'); throw error; }
          }
        };
        return adapter;
      }` : args.path === 'expo-file-system' ? `
      import fs from 'node:fs'; import path from 'node:path';
      export const Paths={document:${JSON.stringify(root)}};
      export class Directory { constructor(...parts){this.uri=path.join(...parts.map(x=>x.uri??x));} create(){fs.mkdirSync(this.uri,{recursive:true});} }
      export class File { constructor(...parts){this.uri=path.join(...parts.map(x=>x.uri??x));} get exists(){return fs.existsSync(this.uri);} async bytes(){return new Uint8Array(fs.readFileSync(this.uri));} async write(bytes){fs.writeFileSync(this.uri,bytes);} async move(file){fs.renameSync(this.uri,file.uri);} }
      ` : `export default { async getItem(key) { return globalThis.__UMEDA_QA_LEGACY__.get(key) ?? null; } };` }));
  } }], logLevel: 'silent' });
  let { libraryStorage } = require(output);
  const legacy = globalThis.__UMEDA_QA_LEGACY__, key = 'scope-a:preference:draft';
  legacy.set('umeda.workbench.v1.scope-a.' + key, 'original draft');
  const storage = libraryStorage('scope-a');
  assert.deepEqual(JSON.parse(await storage.get('scope-a:pending')),oldQueue);
  assert.equal(globalThis.__UMEDA_QA_DB__.prepare('PRAGMA user_version').get().user_version,3);
  assert.equal(globalThis.__UMEDA_QA_DB__.prepare('SELECT value FROM library_values WHERE key=?').get('scope-a:pending').value,JSON.stringify(oldQueue),'original schema-1 records retained');
  assert.equal(await storage.get(key), 'original draft');
  await storage.set(key, null);
  assert.equal(await storage.get(key), null);
  assert.equal(legacy.get('umeda.workbench.v1.scope-a.' + key), 'original draft');
  await storage.commit([{ key: 'catalog', value: 'old catalog' }, { key: 'pending', value: 'old queue' }]);
  globalThis.__UMEDA_QA_DB__.exec("CREATE TRIGGER reject_qa BEFORE INSERT ON library_kv WHEN NEW.value='reject' BEGIN SELECT RAISE(ABORT,'full disk'); END");
  await assert.rejects(storage.commit([{ key: 'catalog', value: 'new catalog' }, { key: 'pending', value: 'reject' }]));
  assert.equal(await storage.get('catalog'), 'old catalog');
  assert.equal(await storage.get('pending'), 'old queue');
  let checks = 0;
  await assert.rejects(storage.commit([{ key: 'catalog', value: 'stale catalog' }, { key: 'pending', value: 'stale queue' }], () => ++checks === 1));
  assert.equal(await storage.get('catalog'), 'old catalog');
  assert.equal(await storage.get('pending'), 'old queue');
  assert.equal(await libraryStorage('scope-b').get('pending'), null);
  // Integration/U03,U06: normalized metadata/outbox, immutable real content files and
  // full-body CJK literal search. Earlier KV-only smoke could not detect split commits.
  const body = '\uFEFF# Beyond the excerpt\n' + 'padding '.repeat(200) + '\n上下文连续性 中文检索 100% [literal]';
  const hash = createHash('sha256').update(body).digest('hex'), cacheKey = 'scope-a:text:notes:'+hash;
  const doc = {path:'note.md',hash,revision:1,size:Buffer.byteLength(body),deleted:false,modifiedAt:1,frontmatter:'',excerpt:''};
  const catalog = {vaults:[{id:'notes',name:'Notes'}],files:{notes:[doc]},cursors:{notes:1},updatedAt:1};
  const edit = {id:'op-1',vaultId:'notes',path:'note.md',baseRevision:1,createdAt:1,text:body};
  await storage.commit([{key:'scope-a:catalog',value:JSON.stringify(catalog)},{key:'scope-a:pending',value:JSON.stringify([edit])}]);
  assert.deepEqual(JSON.parse(await storage.get('scope-a:catalog')),catalog);
  assert.deepEqual(JSON.parse(await storage.get('scope-a:pending')),[edit]);
  assert.equal(globalThis.__UMEDA_QA_DB__.prepare('SELECT count(*) AS n FROM library_documents').get().n,1);
  assert.equal(globalThis.__UMEDA_QA_DB__.prepare('SELECT content_hash FROM library_outbox WHERE id=?').get(edit.id).content_hash,hash);
  assert.equal(await fs.readFile(path.join(root,'umeda-library/scope-a/content',hash),'utf8'),body);
  await storage.set(cacheKey,JSON.stringify(body));
  for (const query of ['中文','上下文连续性','100%','[literal]']) assert.equal((await storage.search([cacheKey],query)).hits.length,1,query);
  assert.equal((await libraryStorage('scope-b').search([cacheKey],'中文')).hits.length,0);
  // Integration/U04,U06: queue and registered byte totals must commit together and
  // deduplicate one blob shared by cache, pin and outbox. No physical cleanup is performed.
  const move={id:'rename-1',vaultId:'notes',from:'note.md',to:'folder/note.md',documentId:'qa-document',baseRevision:1,file:{...doc,documentId:'qa-document'},status:'pending'};
  await storage.set('scope-a:moves',JSON.stringify([move]));
  assert.deepEqual(JSON.parse(await storage.get('scope-a:moves')),[move]);
  const report=await storage.report('scope-a:',[cacheKey]);
  assert.equal(report.cacheBytes,Buffer.byteLength(body));
  assert.equal(report.pinnedBytes,Buffer.byteLength(body));
  assert.equal(report.pendingBytes,Buffer.byteLength(body));
  assert.equal(report.cacheOnlyBytes,0);
  assert.equal((await storage.report('scope-a:',[])).cacheOnlyBytes,0,'outbox content is protected even when unpinned');
  globalThis.__UMEDA_QA_DB__.exec("CREATE TRIGGER reject_move BEFORE INSERT ON library_moves WHEN json_extract(NEW.operation,'$.id')='reject-move' BEGIN SELECT RAISE(ABORT,'full disk'); END");
  await assert.rejects(storage.commit([{key:'scope-a:catalog',value:JSON.stringify({...catalog,updatedAt:2})},{key:'scope-a:moves',value:JSON.stringify([{...move,id:'reject-move'}])}]));
  assert.deepEqual(JSON.parse(await storage.get('scope-a:moves')),[move]);
  assert.equal(JSON.parse(await storage.get('scope-a:catalog')).updatedAt,1);
  const identity='notes:'+hash, bookKey='scope-a:book-indexes';
  const bookIndex={parts:[{location:'page:1',label:'1'}],complete:false,bytes:12};
  const extractedKey='scope-a:extracted:'+identity+':0';
  await storage.commit([{key:extractedKey,value:JSON.stringify('独立书籍全文')},{key:bookKey,value:JSON.stringify({[identity]:bookIndex})}]);
  assert.deepEqual(JSON.parse(await storage.get(bookKey)),{[identity]:bookIndex});
  const completed={...bookIndex,parts:[...bookIndex.parts,{location:'page:2',label:'2'}],complete:true};
  await storage.set(bookKey,JSON.stringify({[identity]:completed}));
  assert.deepEqual(JSON.parse(await storage.get(bookKey)),{[identity]:completed});
  assert.equal(globalThis.__UMEDA_QA_DB__.prepare('SELECT count(*) AS n FROM library_book_parts').get().n,2);
  assert.equal((await storage.search([extractedKey],'书籍')).hits[0].key,extractedKey);
  const fileCount=(await fs.readdir(path.join(root,'umeda-library/scope-a/content'))).length;
  globalThis.__UMEDA_QA_DB__.exec("CREATE TRIGGER reject_queue BEFORE INSERT ON library_outbox WHEN NEW.id='reject-operation' BEGIN SELECT RAISE(ABORT,'full disk'); END");
  await assert.rejects(storage.commit([{key:'scope-a:catalog',value:JSON.stringify({...catalog,updatedAt:2})},{key:'scope-a:pending',value:JSON.stringify([{...edit,id:'reject-operation',text:'new unsaved bytes'}])}]));
  assert.equal(JSON.parse(await storage.get('scope-a:catalog')).updatedAt,1);
  assert.deepEqual(JSON.parse(await storage.get('scope-a:pending')),[edit]);
  assert.ok((await fs.readdir(path.join(root,'umeda-library/scope-a/content'))).length>fileCount,'unreferenced bytes do not imply a committed edit');
  globalThis.__UMEDA_QA_DB__.close();
  delete require.cache[require.resolve(output)];
  ({ libraryStorage } = require(output));
  assert.equal(await libraryStorage('scope-a').get('pending'), 'old queue');
  assert.equal(await libraryStorage('scope-a').get(key), null);
  assert.deepEqual(JSON.parse(await libraryStorage('scope-a').get('scope-a:pending')),[edit]);
  assert.equal((await libraryStorage('scope-a').search([cacheKey],'中文')).hits.length,1);
  assert.deepEqual(JSON.parse(await libraryStorage('scope-a').get('scope-a:moves')),[move]);
  assert.deepEqual(JSON.parse(await libraryStorage('scope-a').get(bookKey)),{[identity]:completed});
  console.log('PASS: native adapter SQL, file-backed normalized documents/outbox, CJK full-body search, split-commit rollback, reopen, tombstones and scope isolation');
} finally {
  try { globalThis.__UMEDA_QA_DB__?.close(); } catch {}
  delete globalThis.__UMEDA_QA_DB__; delete globalThis.__UMEDA_QA_LEGACY__;
  await fs.rm(root, { recursive: true, force: true });
}
