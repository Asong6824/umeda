/**
 * Value: exercise production UmedaRelay.fetch/WS callbacks with in-memory platform ports.
 * Gap: Node HTTP tests cannot simulate DO eviction, durable pairing or pinned bootstrap.
 * Minimal failures: stolen public bootstrap with a changed credential hash; eviction while a
 * join awaits approval; a revoked socket delivering a queued frame. Tier: unit, no real waits.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
// The builtin is provided by workerd; these tests exercise the portable ports.
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import { createRelaySigningKey, issueRelayDeviceCert, signRelayInitialization, createRelayPairSecret, computeRelayPairProof, type RelayInitialization } from '@cindy/device-link';
import { nodeRelayAuthCrypto as crypto } from '@cindy/device-link/node-relay-crypto';
import { createDeviceCredential, hashSecret } from '../../src/credentials';
import { UmedaRelay } from '../worker';
import type { EdgeSocket, ObjectContext, ObjectStorage, RelayEnvironment, SocketAttachment } from '../runtime';
import type { VaultBucket } from '../vault';
import { VaultClient, VaultSyncError } from '@cindy/device-link';

class MemoryStorage implements ObjectStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) this.values.delete(key); }
  async list<T>({ prefix, start, startAfter, end, limit, reverse }: { prefix: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean }) {
    const entries = [...this.values].filter(([key]) => key.startsWith(prefix) && (!start || key >= start) && (!startAfter || key > startAfter) && (!end || key < end)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    if (reverse) entries.reverse();
    return new Map(entries.slice(0, limit).map(([k, v]) => [k, structuredClone(v) as T]));
  }
  async transaction<T>(operation: (storage: ObjectStorage) => Promise<T>): Promise<T> {
    const saved = structuredClone(this.values);
    try { return await operation(this); }
    catch (error) { this.values.clear(); for (const [key, value] of saved) this.values.set(key, value); throw error; }
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}
class Socket implements EdgeSocket {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  closed: number | null = null;
  constructor(private attachment: SocketAttachment) {}
  send(value: string | ArrayBuffer) { this.sent.push(JSON.parse(String(value))); }
  close(code: number) { this.closed = code; this.readyState = 3; }
  serializeAttachment(value: SocketAttachment) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
function setup(bucket?: VaultBucket) {
  const storage = new MemoryStorage();
  const sockets: EdgeSocket[] = [];
  const ctx: ObjectContext = { storage, getWebSockets: () => sockets,
    acceptWebSocket: socket => { sockets.push(socket); }, blockConcurrencyWhile: async fn => fn(), waitUntil() {} };
  const key = createRelaySigningKey(crypto);
  const owner = createDeviceCredential();
  const relayId = randomUUID();
  const init: RelayInitialization = { relayId, name: 'Test relay', ownerDeviceId: 'desktop', ownerDeviceName: 'Test computer',
    ownerUserId: 'local-v1', ownerCredentialHash: owner.credentialHash, ownerPublicKey: key.publicKey,
    ownerCert: issueRelayDeviceCert(crypto, key.seed, { relayId, deviceId: 'desktop', publicKey: key.publicKey, role: 'owner', issuedAt: 1 }) };
  const env = { UMEDA_OWNER_PUBLIC_KEY: key.publicKey, ...(bucket ? { UMEDA_VAULT: bucket } : {}) } as RelayEnvironment;
  let worker = new UmedaRelay(ctx, env);
  const call = (path: string, method = 'GET', body?: unknown, credential?: string, headers?: Record<string, string>) => worker.fetch(new Request(`https://relay.invalid${path}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(credential ? { authorization: `CindyRelay ${credential}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { storage, sockets, key, owner, init, call,
    raw: (request: Request) => worker.fetch(request),
    initialize: () => call('/api/device-link/relay/initialize', 'POST', { ...init, proof: signRelayInitialization(crypto, key.seed, init) }),
    restore(open = false) { if (open) env.UMEDA_AUTH_MODE = 'none'; worker = new UmedaRelay(ctx, env); },
    message: (socket: EdgeSocket, message: unknown) => worker.webSocketMessage(socket, JSON.stringify(message)),
  };
}
const P = '/api/device-link';
// Unit: public production fetch + real VaultClient. New file-sync revision protocol was
// absent from relay tests; two offline writers on the same base must not erase each other.
// Also covers DO eviction, retry idempotency, immutable bytes and durable deletion markers.
describe('personal vault files', () => {
  function vault(hooks: { get?: () => Promise<void>; put?: () => Promise<void> } = {}) {
    const blobs = new Map<string, Uint8Array>();
    const h = setup({
      async put(key, value) { await hooks.put?.(); blobs.set(key, value.slice()); },
      async get(key, options) {
        await hooks.get?.();
        if (options?.range.length === 0) throw new Error('R2 rejects a zero-length range');
        const raw = blobs.get(key);
        const bytes = options && raw ? raw.slice(options.range.offset, options.range.offset + options.range.length) : raw;
        return bytes ? { body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
      },
    });
    h.restore(true);
    const client = new VaultClient('https://relay.invalid', ((input, init) => { const request = new Request(String(input), init); if (init?.body instanceof Uint8Array) request.headers.set('content-length', String(init.body.byteLength)); return h.raw(request); }) as typeof fetch);
    return { ...h, client, blobs };
  }
  // Unit / U03,U04: real REST mutations preserve identity/history and reject a stale restore.
  // Existing file tests have no move/restore transaction or rollback coverage.
  it('moves a document atomically and restores history without overwriting a newer edit', async () => {
    const h = vault(); await h.client.register({ id: 'notes', name: 'Notes' });
    const first = await h.client.write('notes', 'old.md', new TextEncoder().encode('# first'), 0);
    const second = await h.client.write('notes', 'old.md', new TextEncoder().encode('# second'), first.revision);
    const change = (action: string, value: unknown) => h.call('/api/vaults/notes/' + action, 'PUT', value);
    const moved = await change('move', { path: 'old.md', to: 'folder/new.md', baseRevision: second.revision });
    expect(moved.status).toBe(200);
    const newFile = ((await moved.json()) as any).files[1];
    expect(newFile.documentId).toBe(first.documentId);
    const history = await (await h.call('/api/vaults/notes/history?path=folder%2Fnew.md')).json() as any;
    expect(history.files.map((file: any) => file.revision)).toContain(first.revision);
    const historical = await h.call(`/api/vaults/notes/history?path=folder%2Fnew.md&revision=${first.revision}`);
    expect(await historical.text()).toBe('# first');
    expect((await change('restore', { path: 'folder/new.md', revision: first.revision, baseRevision: second.revision })).status).toBe(409);
    const restored = await change('restore', { path: 'folder/new.md', revision: first.revision, baseRevision: newFile.revision });
    const version = ((await restored.json()) as any).files[0];
    expect(version.documentId).toBe(first.documentId);
    expect(new TextDecoder().decode(await h.client.read('notes', version))).toBe('# first');
    const reused = await h.client.write('notes', 'old.md', new TextEncoder().encode('# new document'), newFile.revision - 1);
    expect(reused.documentId).not.toBe(first.documentId);
    // Failure between the source tombstone and target entry must roll back both.
    const original = h.storage.put.bind(h.storage);
    vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => {
      if (key.startsWith('vault-v1:file:notes:') && (value as any)?.path === 'failed.md') throw new Error('disk full');
      await original(key, value);
    });
    expect((await change('move', { path: 'folder/new.md', to: 'failed.md', baseRevision: version.revision })).status).toBe(500);
    expect(new TextDecoder().decode(await h.client.read('notes', version))).toBe('# first');
    h.restore(true);
    expect((await h.client.changes('notes')).files.some(file => file.path === 'failed.md')).toBe(false);
  });
  it('keeps accepted bytes after eviction, deduplicates retries and rejects concurrent stale edits', async () => {
    const h = vault(), bytes = new TextEncoder().encode('first');
    await h.client.register({ id: 'notes', name: 'Notes' });
    const file = await h.client.write('notes', '书籍/笔记.md', bytes, 0);
    h.restore(true);
    expect(await h.client.write('notes', file.path, bytes, 0)).toEqual(file);
    expect(await h.client.read('notes', file)).toEqual(bytes);
    const updates = await Promise.allSettled(['phone', 'desktop'].map(text => h.client.write('notes', file.path, new TextEncoder().encode(text), file.revision)));
    expect(updates.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = updates.find(r => r.status === 'rejected') as PromiseRejectedResult;
    expect(failed.reason).toMatchObject({ status: 409 });
    // Both contenders may stage immutable bytes concurrently; only the CAS winner is published.
    expect(h.blobs.size).toBe(3);
    expect((await h.client.changes('notes')).files).toHaveLength(1);
  });
  // Unit: bounded metadata and binary transport used by the plugin text-only HTTP port.
  // Minimal failures: legacy metadata without summary, and the second 256KiB binary range.
  it('backfills bounded indexes without changing revisions, and serves exact binary ranges', async () => {
    const h = vault(); await h.client.register({ id: 'notes', name: 'Notes' });
    const original = '---\ntype: task\ntitle: 测试索引\nstatus: todo\n---\n# 正文\n内容';
    const file = await h.client.write('notes', 'note.md', new TextEncoder().encode(original), 0);
    for (const [key, value] of h.storage.values) if (key.startsWith('vault-v1:file:notes:')) { const legacy = { ...(value as any) }; delete legacy.summary; h.storage.values.set(key, legacy); }
    h.restore(true);
    const index = await (await h.call('/api/vaults/notes/index')).json() as any;
    expect(index).toMatchObject({ files: [{ ...file, frontmatter: 'type: task\ntitle: 测试索引\nstatus: todo', excerpt: '# 正文\n内容' }], cursor: file.revision, more: false });
    expect((await h.client.changes('notes')).files[0]).toEqual(file);
    const empty = await h.client.write('notes', 'empty.md', new Uint8Array(), 0);
    for (const [key, value] of h.storage.values) if (key.startsWith('vault-v1:file:notes:') && (value as any).path === 'empty.md') { const legacy = { ...(value as any) }; delete legacy.summary; h.storage.values.set(key, legacy); }
    const backfill = await h.call('/api/vaults/notes/index'); expect(backfill.status).toBe(200);
    expect((await backfill.json() as any).files.find((item: any) => item.path === 'empty.md')).toMatchObject({ ...empty, frontmatter: '', excerpt: '' });
    const text = await h.call(`/api/vaults/notes/file?path=note.md&revision=${file.revision}&encoding=text`);
    expect(text.headers.get('content-type')).toContain('text/plain'); expect(await text.text()).toBe(original);
    const bytes = Uint8Array.from({ length: 600_003 }, (_, index) => index % 251);
    const binary = await h.client.write('notes', 'book.pdf', bytes, 0), chunks: Buffer[] = [];
    for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
      const part = await (await h.call(`/api/vaults/notes/file?path=book.pdf&revision=${binary.revision}&encoding=base64&offset=${offset}`)).json() as any;
      expect(part.next).toBe(Math.min(offset + 256 * 1024, bytes.length)); chunks.push(Buffer.from(part.data, 'base64'));
    }
    expect(new Uint8Array(Buffer.concat(chunks))).toEqual(bytes);
    expect((await h.call(`/api/vaults/notes/file?path=book.pdf&revision=${binary.revision}&encoding=base64&offset=-1`)).status).toBe(400);
    const deleted = await h.client.remove('notes', file.path, file.revision);
    expect(await (await h.call('/api/vaults/notes/stat?path=note.md')).json()).toEqual(deleted);
    const large = `---\ntype: task\nnotes: ${'x'.repeat(17_000)}\n---\nbody`;
    await h.client.write('notes', 'large.md', new TextEncoder().encode(large), 0);
    expect((await (await h.call('/api/vaults/notes/index')).json() as any).files.find((item: any) => item.path === 'large.md')).toMatchObject({ indexError: 'frontmatter-too-large', frontmatter: '' });
  });
  // Unit: first-load latency was proportional to 40-row pages, each re-reading all metadata.
  // Minimal input: 45 short records plus enough large frontmatter to cross one byte budget.
  it('batches indexes within a byte budget and reuses the version index across pages and deltas', async () => {
    const h = vault(); await h.client.register({ id: 'notes', name: 'Notes' });
    for (let index = 0; index < 45; index++) await h.client.write('notes', `short-${index}.md`, new TextEncoder().encode('# short'), 0);
    h.restore(true);
    const list = vi.spyOn(h.storage, 'list');
    expect((await (await h.call('/api/vaults/notes/index')).json() as any).files).toHaveLength(40);
    const all = await (await h.call('/api/vaults/notes/index?maxBytes=524288')).json() as any;
    expect(all.files).toHaveLength(45); expect(all.more).toBe(false);
    await h.call(`/api/vaults/notes/index?after=${all.cursor}&maxBytes=524288`);
    expect(list.mock.calls.filter(([options]) => options.prefix === 'vault-v1:file:notes:')).toHaveLength(1);
    const body = new TextEncoder().encode(`---\ntype: source\nnotes: ${'x'.repeat(15000)}\n---\nbody`);
    for (let index = 0; index < 12; index++) await h.client.write('notes', `large-${index}.md`, body, 0);
    let after = all.cursor, more = true; const paths: string[] = [];
    while (more) {
      const response = await h.call(`/api/vaults/notes/index?after=${after}&maxBytes=131072`), text = await response.text();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(131072);
      const page = JSON.parse(text); expect(page.cursor).toBeGreaterThan(after); paths.push(...page.files.map((file: any) => file.path)); after = page.cursor; more = page.more;
    }
    expect(new Set(paths).size).toBe(12); expect(paths).toHaveLength(12);
  });
  // Unit: production fetch must not hold the metadata queue while an R2 read/upload is pending.
  // Controlled promises model a slow attachment without wall-clock sleeps.
  it('keeps metadata and competing saves moving while R2 transfers are stalled, and rechecks the base at commit', async () => {
    let enter!: () => void, release!: () => void, stalled = false;
    let reached = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const h = vault({ get: async () => { if (stalled) { enter(); await gate; } }, put: async () => { if (stalled) { enter(); await gate; } } });
    await h.client.register({ id: 'notes', name: 'Notes' }); const file = await h.client.write('notes', 'note.md', new TextEncoder().encode('base'), 0);
    stalled = true; const reading = h.client.read('notes', file); await reached;
    expect((await h.client.changes('notes')).files).toHaveLength(1); release(); await reading;
    reached = new Promise(resolve => { enter = resolve; }); gate = new Promise(resolve => { release = resolve; });
    const slow = h.client.write('notes', file.path, new TextEncoder().encode('slow'), file.revision); await reached;
    stalled = false; const fast = await h.client.write('notes', file.path, new TextEncoder().encode('fast'), file.revision);
    release(); await expect(slow).rejects.toMatchObject({ status: 409 }); expect(await h.client.read('notes', fast)).toEqual(new TextEncoder().encode('fast'));
  });
  // Unit: byte admission bounds upload preparation independently of metadata/read requests.
  it('bounds unknown-length upload preparation without holding the metadata queue', async () => {
    let entered!: () => void, release!: () => void, writes = 0;
    const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const h = vault({ put: async () => { writes++; if (writes === 1) { entered(); await gate; } } });
    await h.client.register({ id: 'notes', name: 'Notes' });
    const first = h.raw(new Request('https://relay.invalid/api/vaults/notes/file?path=unknown.md', { method: 'PUT', headers: { 'x-vault-base-revision': '0' }, body: 'unknown length' }));
    await reached; const second = h.client.write('notes', 'small.md', new TextEncoder().encode('small'), 0);
    expect((await h.client.changes('notes')).files).toHaveLength(0); expect(writes).toBe(1);
    release(); expect((await first).status).toBe(200); await second; expect(writes).toBe(2);
  });
  // Unit: a failed/lost publication receipt must invalidate the derived warm index.
  it('rebuilds the warm index if storage accepted a file before reporting a write error', async () => {
    const h = vault(); await h.client.register({ id: 'notes', name: 'Notes' });
    const initial = await h.client.write('notes', 'note.md', new TextEncoder().encode('old'), 0);
    await h.client.changes('notes'); const put = h.storage.put.bind(h.storage); let fail = true;
    vi.spyOn(h.storage, 'put').mockImplementation(async (key, value) => { await put(key, value); if (fail && key.startsWith('vault-v1:file:notes:')) { fail = false; throw new Error('lost receipt'); } });
    await expect(h.client.write('notes', initial.path, new TextEncoder().encode('accepted'), initial.revision)).rejects.toMatchObject({ status: 500 });
    const current = (await h.client.changes('notes', initial.revision)).files[0];
    expect(await h.client.read('notes', current)).toEqual(new TextEncoder().encode('accepted'));
    expect(await h.client.write('notes', initial.path, new TextEncoder().encode('accepted'), initial.revision)).toEqual(current);
  });
  // Unit: a pending notification must release on publication, survive reconnect cursors,
  // and carry no document content on the existing relay push channel.
  it('wakes a long poll on an accepted write and repairs a missed hint after eviction', async () => {
    const h = vault(); await h.client.register({ id: 'notes', name: 'Notes' });
    const watch = h.call('/api/vaults/notes/watch?after=0');
    const first = await h.client.write('notes', 'note.md', new TextEncoder().encode('first'), 0);
    expect(await (await watch).json()).toEqual({ revision: first.revision, changed: true });
    expect(await (await h.call(`/api/vaults/notes/watch?after=${first.revision}&wait=0`)).json()).toEqual({ revision: first.revision, changed: false });
    const removed = await h.client.remove('notes', first.path, first.revision); h.restore(true);
    expect(await (await h.call(`/api/vaults/notes/watch?after=${first.revision}`)).json()).toEqual({ revision: removed.revision, changed: true });
    const cancel = new AbortController(), waiting = h.raw(new Request(`https://relay.invalid/api/vaults/notes/watch?after=${removed.revision}`, { signal: cancel.signal })); cancel.abort();
    expect((await waiting).status).toBe(200);
  });
  it('publishes deletion tombstones, retains historical bytes and rejects unsafe paths', async () => {
    const h = vault(); await h.client.register({ id: 'notes', name: 'Notes' });
    const file = await h.client.write('notes', 'note.md', new Uint8Array([1]), 0);
    const deleted = await h.client.remove('notes', file.path, file.revision);
    h.restore(true);
    expect(await h.client.changes('notes', file.revision)).toMatchObject({ files: [{ deleted: true, path: 'note.md' }] });
    expect(await h.client.remove('notes', file.path, file.revision)).toEqual(deleted);
    expect(h.blobs.size).toBe(1);
    await expect(h.client.read('notes', file)).rejects.toBeInstanceOf(VaultSyncError);
    for (const path of ['../outside', '/absolute', '.obsidian/data.json', 'folder\\file', 'secrets.pem']) {
      expect((await h.raw(new Request(`https://relay.invalid/api/vaults/notes/file?path=${encodeURIComponent(path)}`, {
        method: 'PUT', headers: { 'x-vault-base-revision': '0' }, body: 'unsafe',
      }))).status).toBe(400);
    }
  });
});
const C = `${P}/relay/commands`;
const durableInput = (clientId = 'message-1', sessionId = 'task-1') => ({
  clientId, targetDeviceId: 'desktop', sessionId, sendAtMs: 1,
  expectedClearBoundaryMs: null,
  message: { clientId, durableDelivery: true, text: 'test input', persistedContent: '{"text":"test input"}',
    createOpts: { agentKind: 'codex', workingDir: '/project', model: 'test' }, chatMessage: { clientId, role: 'user' } },
});
// Unit: production REST entry protects durable handoff, leases and cancellation. Signed WS
// tests did not cover an offline receiver or a lost HTTP receipt; no clocks actually wait.
describe('personal relay durable inbox', () => {
  async function inbox() {
    const h = setup(); await h.initialize(); const member = await join(h); await member.poll(); h.restore(true);
    const phone = (path: string, method = 'GET', body?: unknown) => h.call(path, method, body, undefined, { 'x-umeda-device-id': 'phone' });
    const host = (path: string, method = 'POST', body: unknown = {}) => h.call(path, method, body, undefined, { 'x-umeda-device-id': 'desktop' });
    await host(`${C}/claim`);
    return { h, phone, host };
  }
  it('acknowledges stored input, survives eviction and lost acknowledgements, and rejects changed retries', async () => {
    const { h, phone, host } = await inbox();
    const input = durableInput();
    expect((await phone(C, 'POST', input)).status).toBe(202);
    h.restore(true);
    const replies = await Promise.all([phone(C, 'POST', input), phone(C, 'POST', input)]);
    expect(replies.map(r => r.status)).toEqual([202, 202]);
    expect((await phone(C, 'POST', { ...input, message: { ...input.message, text: 'different' } })).status).toBe(409);
    const { command } = await (await host(`${C}/claim`)).json() as any;
    expect(command).toMatchObject({ ...input, sourceDeviceId: 'phone' });
    h.restore(true);
    expect(await (await host(`${C}/claim`)).json()).toMatchObject({ command: null, pending: true });
    const ack = { clientId: command.clientId, sourceDeviceId: 'phone', leaseId: command.leaseId, state: 'accepted' };
    expect((await host(`${C}/settle`, 'POST', ack)).status).toBe(200);
    h.restore(true);
    expect((await host(`${C}/settle`, 'POST', ack)).status).toBe(200);
    expect(await (await phone(C, 'POST', input)).json()).toMatchObject({ receipt: { state: 'accepted' } });
    expect(await (await host(`${C}/claim`)).json()).toEqual({ command: null });
    const stored = [...h.storage.values].find(([key]) => key.startsWith('umeda-command-v1:'))![1] as any;
    expect(stored).not.toHaveProperty('input');
  });
  it('preserves task FIFO through eviction and fences stale leases while allowing other tasks', async () => {
    const { h, phone, host } = await inbox();
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (const input of [durableInput('first'), durableInput('second'), durableInput('other', 'task-2')]) await phone(C, 'POST', input);
      h.restore(true);
      const first = (await (await host(`${C}/claim`)).json() as any).command;
      expect(first.clientId).toBe('first');
      const other = (await (await host(`${C}/claim`)).json() as any).command;
      expect(other.clientId).toBe('other');
      now += 61_000; h.restore(true);
      const reclaimed = (await (await host(`${C}/claim`)).json() as any).command;
      expect(reclaimed.clientId).toBe('first');
      expect(reclaimed.leaseId).not.toBe(first.leaseId);
      const ack = (leaseId: string) => ({ clientId: 'first', sourceDeviceId: 'phone', leaseId, state: 'accepted' });
      expect((await host(`${C}/settle`, 'POST', ack(first.leaseId))).status).toBe(409);
      expect((await host(`${C}/settle`, 'POST', ack(reclaimed.leaseId))).status).toBe(200);
      expect((await (await host(`${C}/claim`)).json() as any).command.clientId).toBe('second');
    } finally { clock.mockRestore(); }
  });
  it('cancels before claiming, expires unclaimed inputs, and never mistakes a claimed input for safely expired', async () => {
    const { h, phone, host } = await inbox();
    let now = Date.now(); const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await phone(C, 'POST', durableInput('cancelled'));
      expect(await (await phone(`${C}/cancelled`, 'DELETE')).json()).toMatchObject({ receipt: { state: 'cancelled' } });
      expect(await (await phone(C, 'POST', durableInput('cancelled'))).json()).toMatchObject({ receipt: { state: 'cancelled' } });
      await phone(C, 'POST', durableInput('claimed'));
      const claimed = (await (await host(`${C}/claim`)).json() as any).command;
      expect(await (await phone(`${C}/claimed`, 'DELETE')).json()).toMatchObject({ receipt: { state: 'queued' } });
      await phone(C, 'POST', durableInput('expired', 'task-2'));
      now += 25 * 60 * 60_000; h.restore(true);
      expect(await (await phone(`${C}/claimed`, 'DELETE')).json()).toMatchObject({ receipt: { state: 'queued' } });
      expect(await (await phone(`${C}/expired`)).json()).toMatchObject({ receipt: { state: 'expired' } });
      expect(await (await phone(`${C}/claimed`)).json()).toMatchObject({ receipt: { state: 'queued' } });
      expect((await (await host(`${C}/claim`)).json() as any).command.clientId).toBe(claimed.clientId);
    } finally { clock.mockRestore(); }
  });
});
async function join(h: ReturnType<typeof setup>, approve = true) {
  const { code } = await (await h.call(`${P}/relay/admin/join-codes`, 'POST', {}, h.owner.credential)).json() as any;
  const key = createRelaySigningKey(crypto);
  const body = { code, deviceId: 'phone', deviceName: 'Test phone', accountUserId: 'local-v1', publicKey: key.publicKey,
    proof: computeRelayPairProof(crypto, createRelayPairSecret(crypto), { relayId: h.init.relayId, deviceId: 'phone', publicKey: key.publicKey }) };
  const request = await (await h.call(`${P}/relay/pair`, 'POST', body)).json() as any;
  if (approve) await h.call(`${P}/relay/admin/pair-requests/${request.requestId}/approve`, 'POST', {
    cert: issueRelayDeviceCert(crypto, h.key.seed, { relayId: h.init.relayId, deviceId: 'phone', publicKey: key.publicKey, role: 'member', issuedAt: 2 }),
  }, h.owner.credential);
  return { key, request, poll: () => h.call(`${P}/relay/pair/${request.requestId}?wait=0`, 'GET', undefined, undefined, { 'x-cindy-relay-poll-token': request.pollToken }) };
}
function socket(deviceId: string, credential: string) {
  return new Socket({ credentialHash: hashSecret(credential), connection: { deviceId, ready: true, remoteControlEnabled: false,
    busy: false, lastInboundAt: Date.now(), helloDeadlineAt: Date.now() + 15_000 } });
}
describe('Workers relay public contract', () => {
  // Unit: explicit personal deployment removes pairing and identity validation.
  // Signed fixtures alone missed migration of existing names and live sockets.
  // Minimal input: a previously paired relay followed by unsigned link-open.
  it('migrates public metadata and routes unsigned devices without any credential in open mode', async () => {
    const h = setup(); await h.initialize();
    const member = await join(h);
    const { credential } = await (await member.poll()).json() as any;
    const host = socket('desktop', h.owner.credential), phone = socket('phone', credential);
    h.sockets.push(host, phone); h.restore(true);
    expect((await (await h.call('/health')).json() as any).authMode).toBe('none');
    const result = await (await h.call(`${P}/devices`)).json() as any;
    expect(result.devices).toHaveLength(2);
    expect(result.devices.find((d: any) => d.deviceId === 'desktop').name).toBe('Test computer');
    await h.message(host, { v: 1, kind: 'presence-set', payload: { remoteControlEnabled: true } });
    await h.message(phone, { v: 1, kind: 'link-open', id: 'unsigned', dst: 'desktop' });
    expect(host.sent.at(-1)).toMatchObject({ src: 'phone', id: 'unsigned' });
    expect(host.sent.at(-1)).not.toHaveProperty('auth');
    expect((await h.call(`${P}/relay/admin/join-codes`, 'POST', {})).status).toBe(404);
    const state = h.storage.values.get('umeda-open-state-v1') as any;
    expect(state.devices[0]).not.toHaveProperty('cert');
    expect(state.devices[0]).not.toHaveProperty('credentialHash');
    h.restore(true);
    expect((await h.call(`${P}/devices`)).status).toBe(200);
  });
  it('pins the owner and signs the entire bootstrap, including the credential hash', async () => {
    const h = setup();
    const proof = signRelayInitialization(crypto, h.key.seed, h.init);
    expect((await h.call(`${P}/relay/initialize`, 'POST', { ...h.init, ownerCredentialHash: 'a'.repeat(64), proof })).status).toBe(403);
    expect((await h.initialize()).status).toBe(201);
    h.restore();
    expect((await h.initialize()).status).toBe(200);
    const replacement = { ...h.init, ownerCredentialHash: 'b'.repeat(64) };
    expect((await h.call(`${P}/relay/initialize`, 'POST', { ...replacement, proof: signRelayInitialization(crypto, h.key.seed, replacement) })).status).toBe(409);
    expect((await h.call(`${P}/devices`, 'GET', undefined, h.owner.credential)).status).toBe(200);
    expect((await h.call(`${P}/devices`, 'GET', undefined, 'invalid-credential')).status).toBe(401);
  });
  it('persists approval across eviction and releases a member credential exactly once', async () => {
    const h = setup(); await h.initialize();
    const member = await join(h);
    h.restore();
    const result = await (await member.poll()).json() as any;
    expect(result.status).toBe('approved');
    h.restore();
    expect((await (await member.poll()).json() as any).status).toBe('expired');
    expect((await h.call(`${P}/devices`, 'GET', undefined, result.credential)).status).toBe(200);
    expect((await h.call(`${P}/relay/admin/join-codes`, 'POST', {}, result.credential)).status).toBe(403);
  });
  it('restores sockets, respects remote-control settings and fences queued frames after revocation', async () => {
    const h = setup(); await h.initialize();
    const member = await join(h);
    const { credential } = await (await member.poll()).json() as any;
    const host = socket('desktop', h.owner.credential), phone = socket('phone', credential);
    h.sockets.push(host, phone); h.restore();
    await h.message(phone, { v: 1, kind: 'link-open', id: 'one', src: 'forged', dst: 'desktop' });
    expect(phone.sent.at(-1)?.payload.code).toBe('REMOTE_DISABLED');
    await h.message(host, { v: 1, kind: 'presence-set', payload: { remoteControlEnabled: true } });
    await h.message(phone, { v: 1, kind: 'link-open', id: 'two', src: 'forged', dst: 'desktop' });
    expect(host.sent.at(-1)).toMatchObject({ src: 'phone', id: 'two' });
    await h.call(`${P}/devices/phone`, 'DELETE', undefined, h.owner.credential);
    const sent = host.sent.length;
    await h.message(phone, { v: 1, kind: 'link-open', id: 'three', dst: 'desktop' });
    expect(host.sent).toHaveLength(sent);
    expect(phone.closed).toBe(4410);
  });
  it('keeps signed attachment URLs and byte ranges usable after eviction', async () => {
    const h = setup(); await h.initialize();
    const ticket = await (await h.call(`${P}/media/presign-put`, 'POST', { size: 5, ext: 'txt', contentType: 'text/plain' }, h.owner.credential)).json() as any;
    h.restore();
    expect((await h.raw(new Request(ticket.putUrl, { method: 'PUT', body: 'hello' }))).status).toBe(200);
    h.restore();
    const { getUrl } = await (await h.call(`${P}/media/presign-get`, 'POST', { key: ticket.key }, h.owner.credential)).json() as any;
    const range = await h.raw(new Request(getUrl, { headers: { range: 'bytes=1-3' } }));
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 1-3/5');
    expect(await range.text()).toBe('ell');
    expect((await h.raw(new Request(ticket.putUrl, { method: 'PUT', body: 'again' }))).status).toBe(409);
    const second = await (await h.call(`${P}/media/presign-put`, 'POST', { size: 9 * 1024 * 1024, ext: 'bin', contentType: 'application/octet-stream' }, h.owner.credential)).json() as any;
    expect(second.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
