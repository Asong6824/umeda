/** Integration: real workerd, R2 binding and the production HTTP client; no personal content. */
import assert from 'node:assert/strict';
import { VaultClient } from '@cindy/device-link';
import { startCloudflareRelay } from './cloudflare-runtime';

const relay = await startCloudflareRelay(undefined, undefined, true);
try {
  const client = new VaultClient(relay.localUrl);
  await client.register({ id: 'smoke', name: 'Smoke' });
  const changed = fetch(`${relay.localUrl}/api/vaults/smoke/watch?after=0`).then(response => response.json());
  const bytes = new TextEncoder().encode('# Vault\n来自离线设备的记录');
  const first = await client.write('smoke', '笔记/测试.md', bytes, 0);
  assert.deepEqual(await client.read('smoke', first), bytes);
  assert.deepEqual(await changed, { revision: first.revision, changed: true });
  assert.equal((await client.write('smoke', first.path, bytes, 0)).revision, first.revision);
  const index = await (await fetch(`${relay.localUrl}/api/vaults/smoke/index`)).json() as any;
  assert.equal(index.files[0].revision, first.revision); assert.equal(index.files[0].excerpt, new TextDecoder().decode(bytes));
  for (let n = 0; n < 44; n++) await client.write('smoke', `batch-${n}.md`, new TextEncoder().encode('# small'), 0);
  const batched = await (await fetch(`${relay.localUrl}/api/vaults/smoke/index?maxBytes=524288`)).json() as any;
  assert.equal(batched.files.length, 45); assert.equal(batched.more, false);
  const binary = Uint8Array.from({ length: 530_001 }, (_, index) => index % 251);
  const attachment = await client.write('smoke', 'test.pdf', binary, 0), chunks: Buffer[] = [];
  for (let offset = 0; offset < binary.length; offset += 256 * 1024) {
    const response = await fetch(`${relay.localUrl}/api/vaults/smoke/file?path=test.pdf&revision=${attachment.revision}&encoding=base64&offset=${offset}`);
    assert.equal(response.status, 200); const part = await response.json() as any; chunks.push(Buffer.from(part.data, 'base64'));
  }
  assert.deepEqual(new Uint8Array(Buffer.concat(chunks)), binary);
  const update = await client.write('smoke', first.path, new TextEncoder().encode('updated'), first.revision);
  await assert.rejects(client.write('smoke', first.path, bytes, first.revision), { status: 409 });
  const removed = await client.remove('smoke', first.path, update.revision);
  assert.equal((await client.changes('smoke', update.revision)).files.find(file => file.path === first.path)?.deleted, true);
  assert.equal((await client.remove('smoke', first.path, update.revision)).revision, removed.revision);
  const mutate = async (action: string, value: unknown) => {
    const response = await fetch(`${relay.localUrl}/api/vaults/smoke/${action}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
    assert.equal(response.status, 200, await response.clone().text());
    return await response.json() as { files: Array<typeof first> };
  };
  const history = await (await fetch(`${relay.localUrl}/api/vaults/smoke/history?path=${encodeURIComponent(first.path)}`)).json() as any;
  assert.equal(history.files.some((file: typeof first) => file.revision === first.revision), true);
  const restored = (await mutate('restore', { path: first.path, revision: first.revision, baseRevision: removed.revision })).files[0];
  assert.deepEqual(await client.read('smoke', restored), bytes);
  const moved = (await mutate('move', { path: first.path, to: '笔记/新名字.md', baseRevision: restored.revision })).files[1];
  assert.equal(moved.documentId, first.documentId);
  assert.deepEqual(await client.read('smoke', moved), bytes);
  const old = await fetch(`${relay.localUrl}/api/vaults/smoke/history?path=${encodeURIComponent(moved.path)}&revision=${first.revision}`);
  assert.equal(await old.text(), new TextDecoder().decode(bytes));
  console.log('Vault workerd/R2 integration passed: legacy files, batch/notify/ranges, stable identity, transactional move, historical bytes and CAS restore.');
} finally { await relay.close(); }
