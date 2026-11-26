import { LibraryService } from './service';
import { dispatchLibrary, runLibrary } from './rpc';
import { localValue } from '../localStorage';
import type { HttpReply } from './ports';
import { createLibraryStorage, LIBRARY_SCHEMA_2, LIBRARY_SCHEMA_3, contentHash, base64 } from './storage';
import { fromBase64 } from './encoding';
import { submitPluginCardAction, type PluginCardTasks } from '../cards/actions';

declare const cindy: {
  tasks?: PluginCardTasks;
  library(input: Record<string, unknown>): Promise<{ ok: boolean; rows?: any[]; content?: string; sha256?: string; errorCode?: string; message?: string }>;
  fetch(input: Record<string, unknown>): Promise<{ ok: boolean; status?: number; body?: string; truncated?: boolean }>;
  onHostMessage(listener: () => void): void;
};
const channel = new BroadcastChannel('umeda-kos-v1');
const requests = new Map<string, Promise<unknown>>();
const dbPath = 'umeda-library.sqlite';
async function db(input: Record<string, unknown>) {
  const result = await cindy.library({ dbPath, ...input });
  if (!result.ok) throw new Error('LIBRARY_STORAGE_UNAVAILABLE');
  return result;
}
const configuration = (async () => {
  const response = await fetch('/host-config.json');
  if (!response.ok) throw new Error('LIBRARY_NOT_CONFIGURED');
  const config = await response.json();
  const url = new URL(config.baseUrl), storageUrl = new URL(config.storageBaseUrl ?? config.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('INVALID_LIBRARY_ROUTE');
  if (storageUrl.protocol !== 'https:' || storageUrl.username || storageUrl.password || (storageUrl.port && storageUrl.port !== '443')) throw new Error('INVALID_LIBRARY_ROUTE');
  await db({ op: 'db.open' });
  await db({ op: 'db.migrate', targetVersion: 3, steps: [{ toVersion: 1, sql: ['CREATE TABLE library_values (key TEXT PRIMARY KEY, value TEXT)'] }, { toVersion: 2, sql: LIBRARY_SCHEMA_2 }, { toVersion: 3, sql: LIBRARY_SCHEMA_3 }] });
  return { baseUrl: url.origin, storageBaseUrl: storageUrl.origin };
})();
const storage = createLibraryStorage('plugin', {
  async rows<T>(sql: string, params = []) { await configuration; return (await db({ op: 'db.exec', sql, params })).rows as T[] ?? []; },
  async batch(statements, current) { await configuration; if (!current()) throw new Error('LIBRARY_STOPPED'); await db({ op: 'db.batch', statements }); },
  async legacy(key) {
    const rows = (await db({ op: 'db.exec', sql: 'SELECT value FROM library_values WHERE key=?', params: [key] })).rows ?? [];
    return rows.length ? rows[0].value : localValue('get', key);
  },
  async readBlob(hash) {
    const result = await cindy.library({ op: 'read', path: `content/${hash}`, encoding: 'base64' });
    if (!result.ok) { if (result.errorCode === 'NOT_FOUND') return null; throw new Error('LIBRARY_CONTENT_UNAVAILABLE'); }
    return fromBase64(result.content!);
  },
  async writeBlob(hash, bytes) {
    const result = await cindy.library({ op: 'write', path: `content/${hash}`, encoding: 'base64', content: base64(bytes), ifNotExists: true });
    if (!result.ok || result.sha256 !== hash || contentHash(bytes) !== hash) {
      // An existing immutable object is acceptable only when its actual bytes verify.
      const read = await cindy.library({ op: 'read', path: `content/${hash}`, encoding: 'base64' });
      if (!read.ok || contentHash(fromBase64(read.content!)) !== hash) throw new Error('LIBRARY_CONTENT_WRITE_FAILED');
    }
  },
});
const service = new LibraryService({ async call<T>(operation: string, raw?: unknown): Promise<T> {
  const { baseUrl, storageBaseUrl } = await configuration, payload = (raw ?? {}) as Record<string, any>;
  if (operation === 'info') return { namespace: `relay:${storageBaseUrl}`, atomic: true, contentSearch: true, storageReport: true } as T;
  if (operation === 'get') {
    return await storage.get(payload.key) as T;
  }
  if (operation === 'set' || operation === 'remove') { await storage.set(payload.key, operation === 'remove' ? null : payload.value); return undefined as T; }
  if (operation === 'commit') {
    await storage.commit(payload.entries);
    return undefined as T;
  }
  if (operation === 'storageReport') return await storage.report(payload.namespace, payload.pinnedKeys) as T;
  if (operation === 'contentSearch') return await storage.search(payload.keys, payload.query) as T;
  if (operation !== 'http' || typeof payload.path !== 'string' || !/^\/api\/vaults(?:[/?]|$)/.test(payload.path) || payload.path.includes('..')) throw new Error('INVALID_LIBRARY_REQUEST');
  const result = await cindy.fetch({ url: baseUrl + payload.path, method: payload.method ?? 'GET', headers: payload.headers, ...(payload.body !== undefined ? { body: payload.body } : {}), timeoutMs: 60000, as: 'text' });
  if (!result.ok || result.truncated || typeof result.body !== 'string') throw new Error('LIBRARY_OFFLINE');
  return { status: result.status ?? 200, body: result.body } as T;
} });
service.subscribe(() => channel.postMessage({ event: 'library-state', snapshot: service.getSnapshot() }));
const runner = runLibrary(service, () => true);
channel.onmessage = event => {
  const message = event.data;
  if (!message || typeof message.id !== 'string' || message.id.length > 160 || !['library', 'cardAi'].includes(message.operation)) return;
  let request = requests.get(message.id);
  if (!request) {
    const execute = message.operation === 'cardAi'
      ? cindy.tasks ? submitPluginCardAction(cindy.tasks, message.payload) : Promise.reject(new Error('CARD_AI_UNAVAILABLE'))
      : dispatchLibrary(service, message.payload);
    request = execute.then(result => ({ id: message.id, result }), error => ({ id: message.id,
      error: message.operation === 'cardAi' ? 'AI 任务未能确认提交，请检查插件任务权限与模型连接；结果卡的位置已保留，请勿重复新建。'
        : error instanceof Error && error.message === 'LIBRARY_OFFLINE_SIZE_LIMIT' ? error.message : '资料库操作暂时无法完成，本机内容已保留。', status: (error as { status?: number })?.status }));
    requests.set(message.id, request);
    if (requests.size > 256) requests.delete(requests.keys().next().value!);
  }
  void request.then(reply => channel.postMessage(reply));
};
window.addEventListener('beforeunload', () => runner.stop());
cindy.onHostMessage(() => { void runner.wake(); });
void runner.wake();
