/**
 * Production: syncVault + VaultFolder + CloudVault HTTP, real temporary files, no network.
 * Rule: protocol compatibility / credentials-and-local-storage, preserve divergent edits.
 * Gap: relay REST tests do not cover local bootstrap, offline divergence or filesystem links.
 * Minimal input: two replicas edit one Markdown file before reconnecting. Tier: unit.
 * Standalone Vitest duration: 2.74s locally (2026-11-22; includes collection/setup).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyVaultReplica, syncVault, VaultClient } from '@cindy/device-link';
import { CloudVault } from '../../../../../../packages/device-link-relay/cloudflare/vault';
import type { ObjectStorage } from '../../../../../../packages/device-link-relay/cloudflare/runtime';
import { WorkbenchStore } from '../../../../../../packages/kos-workbench/src/store';
import { patchMarkdown, parseMetadata, splitMarkdown } from '../../../../../../packages/kos-workbench/src/documents';
import { contentDigest, needsReview } from '../../../../../../packages/kos-workbench/src/cards/model';
import type { WorkbenchHost } from '../../../../../../packages/kos-workbench/src/host';
import { createVaultSyncLoop } from '../service';
import { VaultFolder } from '../disk';
import { bootstrapManagedVaults, stageManagedVault, migrateManagedVaults, managedVaultRoot, vaultReplicaRoot } from '../managed';
import { createKnowledgeTools } from '../knowledge';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'umeda-vault-test-')); temporary.push(root);
  const values = new Map<string, unknown>(), blobs = new Map<string, Uint8Array>();
  const storage: ObjectStorage = {
    async get<T>(key: string) { return structuredClone(values.get(key)) as T | undefined; },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async delete(key) { for (const k of typeof key === 'string' ? [key] : key) values.delete(k); },
    async list<T>({ prefix }: { prefix: string }) { return new Map([...values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {},
  };
  const cloud = new CloudVault(storage, {
    async put(key, bytes) { blobs.set(key, bytes.slice()); },
    async get(key) { const bytes = blobs.get(key); return bytes ? { body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) } : null; },
  });
  const client = new VaultClient('https://relay.invalid', (async (input, init) => {
    try { return await cloud.handle(new Request(String(input), init)); }
    catch (error) { return Response.json({}, { status: (error as { status?: number }).status ?? 500 }); }
  }) as typeof fetch);
  await client.register({ id: 'notes', name: 'Notes' });
  async function replica(name: string) {
    const folder = path.join(root, name); await fs.mkdir(folder);
    const history = path.join(root, `${name}-history`), disk = new VaultFolder(folder, history), state = emptyVaultReplica();
    const run = () => syncVault(client, 'notes', disk, state, async () => undefined);
    return { folder, disk, state, history, run };
  }
  return { replica, root, cloud };
}

describe('Vault replicas', () => {
  // Unit: production knowledge callback + disk + existing sync + real CloudVault handler.
  // Rule: Umeda resource architecture / local-storage; existing replica tests do not exercise
  // Agent access, conditional creation, source hashes, chunk reads or route isolation.
  // Minimal failure: Agent writes using a hash read before another writer edited the file.
  it('lets Agents read/search offline and conditionally save through the existing mirror', async () => {
    const h = await setup(), baseUrl = 'https://relay.invalid', userData = path.join(h.root, 'profile');
    const directory = managedVaultRoot(userData, baseUrl, 'notes');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(userData, 'vault-sync.json'), JSON.stringify({ version: 1, vaults: [{ id: 'notes', name: 'Notes', managed: true, directory }] }));
    await fs.writeFile(path.join(directory, 'a.md'), '---\ncustom: keep\n---\n# original');
    await fs.writeFile(path.join(directory, 'b.txt'), 'original second');
    await fs.writeFile(path.join(directory, 'c.pdf'), 'unparsed attachment');
    const execute = createKnowledgeTools(() => ({ userData, baseUrl, isCurrent: () => true }));
    const context = { sessionId: 'current', agentKind: 'codex' as const, workingDir: '/unrelated-code' };
    expect(await execute(context, { operation: 'vaults' })).toMatchObject({ vaults: [{ id: 'notes', name: 'Notes' }] });
    const listed = await execute(context, { operation: 'documents', vault_id: 'notes', limit: 1 });
    expect(listed).toMatchObject({ documents: [{ path: 'a.md' }], next_after_path: 'a.md' });
    expect(JSON.stringify(listed)).not.toContain(userData);
    const search = await execute(context, { operation: 'documents', vault_id: 'notes', query: 'original', limit: 1 });
    expect(search.documents).toHaveLength(1);
    const second = await execute(context, { operation: 'documents', vault_id: 'notes', query: 'original', after_path: 'a.md' });
    expect(second).toMatchObject({ documents: [{ source: { path: 'b.txt' } }], partial: true, excluded_attachments: 1 });
    const first = await execute(context, { operation: 'read', vault_id: 'notes', path: 'a.md', limit: 5 });
    const hash = (first.source as { hash: string }).hash;
    expect(first).toMatchObject({ text: '---\nc', next_offset: 5 });
    const rest = await execute(context, { operation: 'read', vault_id: 'notes', path: 'a.md', offset: 5, expected_hash: hash });
    expect(String(first.text) + rest.text).toBe('---\ncustom: keep\n---\n# original');
    expect(await execute(context, { operation: 'write', vault_id: 'notes', path: 'a.md', expected_hash: null, text: 'must not overwrite' })).toMatchObject({ ok: false, errorCode: 'KNOWLEDGE_CONFLICT' });
    await fs.writeFile(path.join(directory, 'a.md'), 'concurrent edit');
    expect(await execute(context, { operation: 'read', vault_id: 'notes', path: 'a.md', offset: 5, expected_hash: hash })).toMatchObject({ ok: false, errorCode: 'KNOWLEDGE_CONFLICT' });
    expect(await execute(context, { operation: 'write', vault_id: 'notes', path: 'a.md', expected_hash: hash, text: 'stale' })).toMatchObject({ ok: false, errorCode: 'KNOWLEDGE_CONFLICT' });
    expect(await fs.readFile(path.join(directory, 'a.md'), 'utf8')).toBe('concurrent edit');
    const fresh = await execute(context, { operation: 'read', vault_id: 'notes', path: 'a.md' });
    const saved = await execute(context, { operation: 'write', vault_id: 'notes', path: 'a.md', expected_hash: (fresh.source as { hash: string }).hash, text: 'Agent saved offline' });
    expect(saved).toMatchObject({ status: 'local_saved', sync_status: 'not_confirmed' });
    const history = path.join(vaultReplicaRoot(userData, baseUrl, 'notes'), 'history');
    const versions = (await fs.readdir(history)).filter(name => !name.endsWith('.json'));
    expect(await fs.readFile(path.join(history, versions[0]), 'utf8')).toBe('concurrent edit');
    // No special Agent upload path: the ordinary mirror publishes the saved bytes.
    const client = new VaultClient(baseUrl, (async (url, init) => h.cloud.handle(new Request(String(url), init))) as typeof fetch);
    await syncVault(client, 'notes', new VaultFolder(directory, history), emptyVaultReplica(), async () => {});
    const phone = await h.replica('phone'); await phone.run();
    expect(await fs.readFile(path.join(phone.folder, 'a.md'), 'utf8')).toBe('Agent saved offline');
    const other = createKnowledgeTools(() => ({ userData, baseUrl: 'https://other.invalid', isCurrent: () => true }));
    expect(await other(context, { operation: 'read', vault_id: 'notes', path: 'a.md' })).toMatchObject({ ok: false, errorCode: 'KNOWLEDGE_VAULT_NOT_AVAILABLE' });
    for (const relative of ['../outside.md', '.obsidian/config.md', 'linked/private.md', 'c.pdf']) {
      const result = await execute(context, { operation: 'read', vault_id: 'notes', path: relative });
      expect(result.ok).toBe(false);
    }
    // Payload pagination must resume at the first omitted result, even with long UTF-8 excerpts.
    for (let index = 0; index < 100; index++) await fs.writeFile(path.join(directory, `page-${String(index).padStart(3, '0')}.md`), '命中'.repeat(200));
    const page = await execute(context, { operation: 'documents', vault_id: 'notes', path_prefix: 'page-', query: '命中', limit: 100 });
    const results = page.documents as Array<{ source: { path: string } }>;
    expect(results.length).toBeLessThan(100);
    expect(page.next_after_path).toBe(results.at(-1)?.source.path);
    const next = await execute(context, { operation: 'documents', vault_id: 'notes', path_prefix: 'page-', query: '命中', limit: 100, after_path: String(page.next_after_path) });
    expect(results.length + (next.documents as unknown[]).length).toBe(100);
    // Card-format writes acquire host provenance, keep identity, and cannot self-approve.
    // Legacy byte-for-byte writes above remain compatible; only new/explicit cards opt in.
    const createdCard = await execute(context, { operation: 'write', vault_id: 'notes', path: 'cards/ai.md', expected_hash: null, text: '# Generated card\n\nAn idea' });
    const cardText = await fs.readFile(path.join(directory, 'cards', 'ai.md'), 'utf8');
    const cardMeta = parseMetadata(splitMarkdown(cardText).frontmatter);
    expect(cardMeta).toMatchObject({ type: 'card', generated_by: 'ai' });
    expect(needsReview(cardText)).toBe(true);
    const accepted = patchMarkdown(cardText, { kos_reviewed_hash: contentDigest(cardText), human_field: 'keep' });
    await fs.writeFile(path.join(directory, 'cards', 'ai.md'), accepted);
    const acceptedRead = await execute(context, { operation: 'read', vault_id: 'notes', path: 'cards/ai.md' });
    const retagged = await execute(context, { operation: 'write', vault_id: 'notes', path: 'cards/ai.md', expected_hash: (acceptedRead.source as { hash: string }).hash, text: patchMarkdown(accepted, { tags: ['topic'], card_id: 'must-not-replace' }) });
    const afterTag = await fs.readFile(path.join(directory, 'cards', 'ai.md'), 'utf8');
    expect(parseMetadata(splitMarkdown(afterTag).frontmatter)).toMatchObject({ card_id: cardMeta.card_id, human_field: 'keep' });
    expect(needsReview(afterTag)).toBe(false);
    const forged = patchMarkdown(afterTag, {}, 'A new AI conclusion');
    const edited = await execute(context, { operation: 'write', vault_id: 'notes', path: 'cards/ai.md', expected_hash: (retagged.source as { hash: string }).hash, text: patchMarkdown(forged, { generated_by: 'human', kos_reviewed_hash: contentDigest(forged) }) });
    expect(edited.status).toBe('local_saved');
    const finalCard = await fs.readFile(path.join(directory, 'cards', 'ai.md'), 'utf8');
    expect(needsReview(finalCard)).toBe(true);
    expect(parseMetadata(splitMarkdown(finalCard).frontmatter).generated_by).toBe('ai');
    expect(await execute(context, { operation: 'write', vault_id: 'notes', path: 'cards/ai.md', expected_hash: (edited.source as { hash: string }).hash, text: '---\ntype: [broken\n---\nMust not erase the card ID' })).toMatchObject({ ok: false, errorCode: 'INVALID_CARD_METADATA' });
    expect(await fs.readFile(path.join(directory, 'cards', 'ai.md'), 'utf8')).toBe(finalCard);
    expect((createdCard.source as { hash: string }).hash).not.toBe((edited.source as { hash: string }).hash);
    const humanCard = patchMarkdown('', { type: 'card', card_id: 'human-note', generated_by: 'human' }, 'My own idea');
    await fs.writeFile(path.join(directory, 'cards', 'human.md'), humanCard);
    const humanRead = await execute(context, { operation: 'read', vault_id: 'notes', path: 'cards/human.md' });
    await execute(context, { operation: 'write', vault_id: 'notes', path: 'cards/human.md', expected_hash: (humanRead.source as { hash: string }).hash, text: patchMarkdown(humanCard, { tags: ['organized'] }) });
    const organized = await fs.readFile(path.join(directory, 'cards', 'human.md'), 'utf8');
    expect(parseMetadata(splitMarkdown(organized).frontmatter).generated_by).toBe('human');
    expect(needsReview(organized)).toBe(false);
    const changed = createKnowledgeTools(() => ({ userData, baseUrl, isCurrent: () => false }));
    expect(await changed(context, { operation: 'write', vault_id: 'notes', path: 'new.md', expected_hash: null, text: 'wrong owner' })).toMatchObject({ ok: false, errorCode: 'KNOWLEDGE_SCOPE_CHANGED' });
    await expect(fs.stat(path.join(directory, 'new.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  // Unit / U01: a fresh profile creates owned storage; an existing binding is never replaced.
  // Two fresh installs use the same remote ID. Import verifies bytes and preserves the original.
  it('creates a managed library without configuration and stages an existing vault without changing its source', async () => {
    const h = await setup(), userData = path.join(h.root, 'profile'); await fs.mkdir(userData);
    const register = vi.fn().mockResolvedValue(undefined);
    const config = await bootstrapManagedVaults(userData, 'https://relay.invalid', { list: async () => [], register });
    expect(config.vaults[0].id).toBe('umeda-default');
    expect(config.vaults[0].directory.startsWith(userData + path.sep)).toBe(true);
    expect((await fs.stat(config.vaults[0].directory)).isDirectory()).toBe(true);
    expect(register).toHaveBeenCalledWith({ id: 'umeda-default', name: 'Umeda' });
    const client = { list: vi.fn().mockRejectedValue(new Error('must not query')), register };
    expect(await bootstrapManagedVaults(userData, 'https://relay.invalid', client)).toEqual(config);
    expect(client.list).not.toHaveBeenCalled();
    const source = await h.replica('original'); await fs.writeFile(path.join(source.folder, 'note.md'), '# keep');
    const staged = await stageManagedVault(userData, 'https://relay.invalid', { id: 'imported', name: 'Notes', directory: source.folder });
    expect(await fs.readFile(path.join(staged.directory, 'note.md'), 'utf8')).toBe('# keep');
    expect(await fs.readFile(path.join(source.folder, 'note.md'), 'utf8')).toBe('# keep');
    expect(JSON.parse(await fs.readFile(path.join(userData, 'vault-sync.json'), 'utf8'))).toEqual(config);
    const oldConfig = { version: 1 as const, vaults: [{ id: 'imported', name: 'Notes', directory: source.folder }] };
    await fs.writeFile(path.join(userData, 'vault-sync.json'), JSON.stringify(oldConfig));
    await expect(migrateManagedVaults(userData, 'https://relay.invalid', () => false)).rejects.toThrow('VAULT_IMPORT_INTERRUPTED');
    expect(JSON.parse(await fs.readFile(path.join(userData, 'vault-sync.json'), 'utf8'))).toEqual(oldConfig);
    // A source edit between staging and cutover must be copied on the resumed pass.
    await fs.writeFile(path.join(source.folder, 'note.md'), '# newer');
    const activated = await migrateManagedVaults(userData, 'https://relay.invalid', () => true);
    expect(activated.vaults[0]).toMatchObject({ managed: true, directory: staged.directory });
    expect(await fs.readFile(path.join(staged.directory, 'note.md'), 'utf8')).toBe('# newer');
    expect((await fs.readdir(userData)).some(name => name.startsWith('vault-sync.before-managed-'))).toBe(true);
    expect(await fs.readFile(path.join(source.folder, 'note.md'), 'utf8')).toBe('# newer');
    await fs.writeFile(path.join(userData, 'vault-sync.json'), '{broken');
    await expect(bootstrapManagedVaults(userData, 'https://relay.invalid', client)).rejects.toThrow();
    expect(await fs.readFile(path.join(userData, 'vault-sync.json'), 'utf8')).toBe('{broken');
  });
  it('bootstraps without deleting local content, preserves offline edits and propagates tombstones', async () => {
    const h = await setup(), mac = await h.replica('mac'), phone = await h.replica('phone');
    await fs.writeFile(path.join(mac.folder, 'note.md'), 'base');
    expect(await mac.run()).toMatchObject({ uploaded: 1 });
    expect(await phone.run()).toMatchObject({ downloaded: 1 });
    await fs.writeFile(path.join(mac.folder, 'note.md'), 'mac edit'); await mac.run();
    await fs.writeFile(path.join(phone.folder, 'note.md'), 'phone edit');
    const result = await phone.run();
    expect(result.conflicts).toHaveLength(1);
    expect(await fs.readFile(path.join(phone.folder, result.conflicts[0]), 'utf8')).toBe('phone edit');
    expect(await fs.readFile(path.join(phone.folder, 'note.md'), 'utf8')).toBe('mac edit');
    await phone.run(); await mac.run();
    expect(await fs.readFile(path.join(mac.folder, result.conflicts[0]), 'utf8')).toBe('phone edit');
    await fs.unlink(path.join(mac.folder, 'note.md')); await mac.run(); await phone.run();
    await expect(fs.stat(path.join(phone.folder, 'note.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    const saved = await fs.readdir(phone.history);
    const originals = await Promise.all(saved.filter(p => !p.endsWith('.json')).map(p => fs.readFile(path.join(phone.history, p), 'utf8')));
    expect(originals).toContain('mac edit');
    expect(await phone.run()).toMatchObject({ uploaded: 0, downloaded: 0 });
  });
  // Unit: full content path previously split across isolated UI-store and disk tests.
  // Minimal failure: one manual task edit must reach the real Mac folder, then return to the index.
  it('carries workbench edits through cloud bytes into the Mac folder and indexes local edits back', async () => {
    const h = await setup(), mac = await h.replica('mac'), local = new Map<string, string>();
    const original = '---\ntype: task\ntitle: Action\n# keep\nstatus: todo\ncustom: personal\n---\n# Original body';
    await fs.writeFile(path.join(mac.folder, 'action.md'), original); await mac.run();
    const host: WorkbenchHost = { async call<T>(operation: string, raw?: unknown): Promise<T> {
      const payload = raw as any;
      if (operation === 'info') return { namespace: 'workbench' } as T;
      if (operation === 'get') return (local.get(payload.key) ?? null) as T;
      if (operation === 'set') { local.set(payload.key, payload.value); return undefined as T; }
      if (operation === 'remove') { local.delete(payload.key); return undefined as T; }
      if (operation === 'http') {
        try { const response = await h.cloud.handle(new Request(`https://relay.invalid${payload.path}`, { method: payload.method, body: payload.body, headers: payload.headers })); return { status: response.status, body: await response.text() } as T; }
        catch (error) { return { status: (error as { status?: number }).status ?? 500, body: '{}' } as T; }
      }
      throw new Error('Unexpected host operation');
    } };
    const workbench = new WorkbenchStore(host); await workbench.initialize();
    const first = workbench.files('notes')[0], changed = patchMarkdown(await workbench.readText('notes', first), { status: 'done' });
    await workbench.saveText('notes', first.path, changed, first.revision); await workbench.refresh(); await mac.run();
    expect(await fs.readFile(path.join(mac.folder, first.path), 'utf8')).toBe(changed);
    expect(changed).toContain('# keep'); expect(changed).toContain('custom: personal');
    const fromMac = patchMarkdown(changed, { priority: 'P1' }, '# Updated on Mac');
    await fs.writeFile(path.join(mac.folder, first.path), fromMac); await mac.run(); await workbench.refresh();
    const updated = workbench.files('notes')[0];
    expect(updated.frontmatter).toContain('priority: P1'); expect(await workbench.readText('notes', updated)).toBe(fromMac);
  });
  it('does not follow a linked directory, sync settings, or overwrite an unexpected local writer', async () => {
    const h = await setup(), replica = await h.replica('mac');
    const outside = path.join(h.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'secret.md'), 'secret');
    await fs.symlink(outside, path.join(replica.folder, 'linked'));
    await fs.mkdir(path.join(replica.folder, '.obsidian')); await fs.writeFile(path.join(replica.folder, '.obsidian', 'data.json'), 'private');
    await fs.writeFile(path.join(replica.folder, '__proto__'), 'ordinary note');
    expect(Object.keys(await replica.disk.scan())).toEqual(['__proto__']);
    await expect(replica.disk.read('linked/secret.md')).rejects.toThrow('VAULT_UNSAFE_DIRECTORY');
    await expect(replica.disk.replace('linked/secret.md', new Uint8Array([1]), null)).rejects.toThrow('VAULT_UNSAFE_DIRECTORY');
    await fs.writeFile(path.join(replica.folder, 'note.md'), 'new edit');
    await expect(replica.disk.replace('note.md', new Uint8Array([1]), 'stale hash')).rejects.toThrow('VAULT_LOCAL_CHANGED');
    expect(await fs.readFile(path.join(replica.folder, 'note.md'), 'utf8')).toBe('new edit');
    await replica.run();
    expect(Object.hasOwn(replica.state.base, '__proto__')).toBe(true);
  });
  // Unit: file/socket hints received during a mirror pass must coalesce without bypassing error backoff.
  it('runs one trailing pass for concurrent change hints and preserves backoff after failure', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
      const run = vi.fn().mockImplementationOnce(() => gate).mockResolvedValue(undefined), loop = createVaultSyncLoop(run, () => {});
      loop.wake(); loop.wake(); loop.wake(); release(); await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2); loop.stop(); expect(vi.getTimerCount()).toBe(0);
      const failed = vi.fn().mockRejectedValue(new Error('offline')), retry = createVaultSyncLoop(failed, () => {});
      retry.wake(); await vi.advanceTimersByTimeAsync(0); retry.wake(); retry.wake();
      await vi.advanceTimersByTimeAsync(59999); expect(failed).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); expect(failed).toHaveBeenCalledTimes(2); retry.stop();
    } finally { vi.useRealTimers(); }
  });

});
