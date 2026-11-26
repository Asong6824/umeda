/**
 * Production: createMobileVaultReader, persisted catalog and hash-verified offline bytes.
 * Rule: credentials/local-storage route generations; documents must survive loss of the Mac.
 * Gap: existing fileAccessCache covers live RPC, not independent Cloudflare reads.
 * Minimal inputs: one cached document, corrupt download, or a route switch in flight. Tier: unit.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
const memory = vi.hoisted(() => ({
  standalone: true,
  ownerGeneration: 1,
  settings: new Map<string, string>(), files: new Map<string, Uint8Array>(),
  route: { authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'relay' } as { authMode: string; baseUrl: string; relayId: string } | null,
}));
vi.mock('@/config/standalone', () => ({ get UMEDA_STANDALONE() { return memory.standalone; } }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => memory.settings.get(key) ?? null,
  setItem: async (key: string, value: string) => { memory.settings.set(key, value); },
} }));
vi.mock('expo-file-system', () => ({
  Paths: { document: '/documents' },
  Directory: class {
    uri: string;
    constructor(...parts: Array<string | { uri: string }>) { this.uri = parts.map(p => typeof p === 'string' ? p : p.uri).join('/'); }
    create() {}
  },
  File: class {
    uri: string;
    constructor(parent: { uri: string }, name: string) { this.uri = `${parent.uri}/${name}`; }
    get exists() { return memory.files.has(this.uri); }
    async bytes() { return memory.files.get(this.uri)!.slice(); }
    write(bytes: Uint8Array) { memory.files.set(this.uri, bytes.slice()); }
    delete() { memory.files.delete(this.uri); }
  },
}));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getActiveSelfHostedRelay: () => memory.route }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({ accountKey: 'owner', generation: memory.ownerGeneration }), isMobileAuthOwnerCurrent: (owner: { generation: number }) => owner.generation === memory.ownerGeneration }));
import { workbenchReplyScript } from '@/vault/bridge';
import { createVaultNotifier, subscribeVaultChanges } from '@/vault/events';
import { createMobileVaultReader } from '@/vault/client';
import { vaultStorageScope } from '@/vault/scope';
const bytes = new TextEncoder().encode('# Note');
const entry = { path: 'note.md', revision: 1, hash: bytesToHex(sha256(bytes)), size: bytes.length, deleted: false, modifiedAt: 1 };
beforeEach(() => {
  memory.standalone = true;
  vi.stubEnv('EXPO_PUBLIC_UMEDA_RELAY_URL', undefined);
  vi.stubEnv('EXPO_PUBLIC_UMEDA_PREVIOUS_RELAY_URL', undefined);
  memory.settings.clear(); memory.files.clear(); memory.ownerGeneration = 1;
  memory.route = { authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'relay' };
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('mobile Vault offline reader', () => {
  // Unit: changing only the public hostname must retain previously downloaded
  // bytes and drafts/queue namespace; prior tests only exercised the same URL.
  // Minimal input: one cached file, explicit build alias, then no network.
  it('retains offline content when the build explicitly moves the same relay to a new hostname', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/vaults')
      ? Response.json({ vaults: [{ id: 'notes', name: 'Notes' }] }) : url.includes('/changes')
        ? Response.json({ files: [entry], cursor: 1, more: false }) : new Response(bytes)));
    const old = createMobileVaultReader();
    const scope = vaultStorageScope('owner', { authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'relay' });
    await old.refresh(); const downloaded = await old.read('notes', entry);
    vi.stubEnv('EXPO_PUBLIC_UMEDA_RELAY_URL', 'https://new.invalid');
    vi.stubEnv('EXPO_PUBLIC_UMEDA_PREVIOUS_RELAY_URL', 'https://relay.invalid');
    memory.route = { authMode: 'none', baseUrl: 'https://new.invalid', relayId: 'relay' };
    expect(vaultStorageScope('owner', { ...memory.route, authMode: 'none' })).toBe(scope);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const moved = createMobileVaultReader();
    expect((await moved.cached()).files.notes).toEqual([entry]);
    expect(await moved.read('notes', entry)).toEqual(downloaded);
    expect(fetch).not.toHaveBeenCalled();
    memory.route = { authMode: 'none', baseUrl: 'https://unrelated.invalid', relayId: 'relay' };
    expect((await createMobileVaultReader().cached()).vaults).toEqual([]);
    memory.route = { authMode: 'none', baseUrl: 'https://new.invalid', relayId: 'different' };
    expect((await createMobileVaultReader().cached()).vaults).toEqual([]);
    expect(vaultStorageScope('another-owner', { authMode: 'none', baseUrl: 'https://new.invalid', relayId: 'relay' })).not.toBe(scope);
    memory.standalone = false;
    expect(vaultStorageScope('owner', { authMode: 'none', baseUrl: 'https://new.invalid', relayId: 'relay' })).not.toBe(scope);
  });
  it.each(['http://relay.invalid', 'https://user:secret@relay.invalid', 'https://relay.invalid/path', 'not-a-url'])(
    'ignores an invalid previous-endpoint declaration: %s', previous => {
      const route = { authMode: 'none' as const, baseUrl: 'https://new.invalid', relayId: 'relay' };
      const original = vaultStorageScope('owner', route);
      vi.stubEnv('EXPO_PUBLIC_UMEDA_RELAY_URL', route.baseUrl);
      vi.stubEnv('EXPO_PUBLIC_UMEDA_PREVIOUS_RELAY_URL', previous);
      expect(vaultStorageScope('owner', route)).toBe(original);
    },
  );
  it('keeps a persisted catalog and downloaded bytes available after network loss and reader recreation', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/api/vaults')
      ? Response.json({ vaults: [{ id: 'notes', name: 'Notes' }] }) : url.includes('/changes')
        ? Response.json({ files: [entry], cursor: 1, more: false }) : new Response(bytes)));
    const reader = createMobileVaultReader();
    expect((await reader.refresh()).files.notes).toEqual([entry]);
    const downloaded = await reader.read('notes', entry);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    const offline = createMobileVaultReader();
    expect((await offline.cached()).vaults).toEqual([{ id: 'notes', name: 'Notes' }]);
    expect(await offline.read('notes', entry)).toEqual(downloaded);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not cache bytes with a mismatched digest', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new TextEncoder().encode('wrong!'))));
    await expect(createMobileVaultReader().read('notes', entry)).rejects.toThrow('VAULT_HASH_MISMATCH');
    expect(memory.files.size).toBe(0);
  });
  it('discards a late response from a previous relay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { memory.route = null; return new Response(bytes); }));
    await expect(createMobileVaultReader().read('notes', entry)).rejects.toThrow('VAULT_ROUTE_CHANGED');
    expect(memory.files.size).toBe(0);
  });
  // Unit: socket hints may arrive after the view changed owner/relay. They must not enter a new scope.
  it('delivers only current-owner, current-route Vault hints and detaches listeners', () => {
    let current = true; const notify = createVaultNotifier(() => current), listener = vi.fn(), off = subscribeVaultChanges(listener);
    try {
      notify({ vaultId: 'notes', revision: 1 }); expect(listener).toHaveBeenLastCalledWith('notes', 1);
      notify({ vaultId: '../notes', revision: 2 }); notify({ vaultId: 'notes', revision: 0 });
      memory.route = { authMode: 'none', baseUrl: 'https://other.invalid', relayId: 'other' }; notify({ vaultId: 'notes', revision: 2 });
      memory.route = { authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'relay' }; memory.ownerGeneration++; notify({ vaultId: 'notes', revision: 3 });
      const fresh = createVaultNotifier(() => current); fresh({ vaultId: 'notes', revision: 4 });
      current = false; fresh({ vaultId: 'notes', revision: 5 }); expect(listener).toHaveBeenCalledTimes(2);
      off(); current = true; fresh({ vaultId: 'notes', revision: 6 }); expect(listener).toHaveBeenCalledTimes(2);
    } finally { off(); }
  });

  // Unit: double escaping '<' changed native Markdown bytes and broke SHA-256 checks.
  it('delivers exact Markdown and arbitrary JSON text through the native JavaScript reply', () => {
    const body = '# Note\n<div>HTML & "quotes"</div>\n\\u003c is literal\n</script>\u2028';
    const reply = { id: 'test', result: { status: 200, body } }, received = vi.fn();
    Function('window', workbenchReplyScript(reply))({ umedaWorkbenchReply: received });
    expect(received).toHaveBeenCalledWith(reply);
  });

});
