import { CloudVault } from '../../device-link-relay/cloudflare/vault';
import type { ObjectStorage } from '../../device-link-relay/cloudflare/runtime';
import type { WorkbenchHost } from '../src/host';

export function fixture() {
  const values = new Map<string, unknown>(), blobs = new Map<string, Uint8Array>(), local = new Map<string, string>();
  const storage: ObjectStorage = {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(keys) { for (const key of typeof keys === 'string' ? [keys] : keys) values.delete(key); },
    async list<T>({ prefix, start, startAfter, end, limit, reverse }: { prefix: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean }) {
      const entries = [...values].filter(([key]) => key.startsWith(prefix) && (!start || key >= start) && (!startAfter || key > startAfter) && (!end || key < end)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
      if (reverse) entries.reverse();
      return new Map(entries.slice(0, limit)) as Map<string, T>;
    },
    async transaction<T>(operation: (storage: ObjectStorage) => Promise<T>) {
      const saved = structuredClone(values);
      try { return await operation(storage); }
      catch (error) { values.clear(); for (const [key, value] of saved) values.set(key, value); throw error; }
    },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {},
  };
  const cloud = new CloudVault(storage, {
    async put(key, value) { blobs.set(key, value.slice()); },
    async get(key, options) {
      const raw = blobs.get(key); if (!raw) return null;
      const bytes = options ? raw.slice(options.range.offset, options.range.offset + options.range.length) : raw.slice();
      return { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    },
  });
  let offline = false;
  const callHttp = async (path: string, method = 'GET', body?: string, headers?: Record<string, string>) => {
    try {
      const response = await cloud.handle(new Request(`https://relay.invalid${path}`, { method, body, headers }));
      return { status: response.status, body: await response.text() };
    } catch (error) { return { status: (error as { status?: number }).status ?? 500, body: '{}' }; }
  };
  const host: WorkbenchHost = { async call<T>(operation: string, raw?: unknown): Promise<T> {
    const payload = raw as Record<string, any>;
    if (operation === 'info') return { namespace: 'fixture', platform: 'desktop' } as T;
    if (operation === 'get') return (local.get(payload.key) ?? null) as T;
    if (operation === 'set') { local.set(payload.key, payload.value); return undefined as T; }
    if (operation === 'remove') { local.delete(payload.key); return undefined as T; }
    if (operation === 'http') {
      if (offline) throw new Error('offline');
      return await callHttp(payload.path, payload.method, payload.body, payload.headers) as T;
    }
    return undefined as T;
  } };
  const seed = async (path: string, text: string | Uint8Array, revision = 0) => {
    const response = await cloud.handle(new Request(`https://relay.invalid/api/vaults/notes/file?path=${encodeURIComponent(path)}`, { method: 'PUT', headers: { 'x-vault-base-revision': String(revision) }, body: text as BodyInit }));
    return response.json();
  };
  return { host, local, values, blobs, seed, callHttp, setOffline(value: boolean) { offline = value; },
    async initialize() { await callHttp('/api/vaults/notes', 'PUT', JSON.stringify({ name: 'KOS' }), { 'content-type': 'application/json' }); } };
}
