/** Local workerd harness. Only code is written to a unique OS temp directory. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelayInitialization } from '@cindy/device-link';

export async function startCloudflareRelay(init?: RelayInitialization, proof?: string, open = false) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'umeda-workerd-'));
  let runtime: Miniflare | undefined;
  try {
    const scriptPath = path.join(dir, 'worker.mjs');
    await build({ entryPoints: [fileURLToPath(new URL('../cloudflare/worker.ts', import.meta.url))],
      outfile: scriptPath, bundle: true, platform: 'node', format: 'esm', target: 'es2022', external: ['node:*', 'cloudflare:*'], logLevel: 'silent' });
    runtime = new Miniflare(convertV4MiniflareOptions({ name: 'umeda', rootPath: dir, modules: true, scriptPath, host: '127.0.0.1', port: 0, compatibilityDate: '2026-11-14',
      compatibilityFlags: ['nodejs_compat'], bindings: open ? { UMEDA_AUTH_MODE: 'none' } : { UMEDA_OWNER_PUBLIC_KEY: init!.ownerPublicKey },
      durableObjects: { UMEDA_RELAY: { className: 'UmedaRelay', useSQLite: true }, UMEDA_WORK: { className: 'UmedaWork', useSQLite: true } },
      ...(open ? { r2Buckets: ['UMEDA_VAULT'] } : {}),
    }));
    const localUrl = (await runtime.ready).origin;
    const response = open ? await fetch(`${localUrl}/health`) : await fetch(`${localUrl}/api/device-link/relay/initialize`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...init, proof }) });
    if (!response.ok) throw new Error(`Workers relay initialization failed (${response.status}): ${await response.text()}`);
    const running = runtime;
    return { localUrl, close: async () => { await running.dispose(); await rm(dir, { recursive: true, force: true }); } };
  } catch (error) { await runtime?.dispose(); await rm(dir, { recursive: true, force: true }); throw error; }
}
