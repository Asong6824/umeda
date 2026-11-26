import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VaultClient, emptyVaultReplica, isVaultId, isVaultReplicaState, syncVault, type VaultReplicaState } from '@cindy/device-link';
import { VaultFolder } from './disk';
import { bootstrapManagedVaults, migrateManagedVaults, vaultReplicaRoot } from './managed';

export interface VaultConfiguration { id: string; name: string; directory: string; managed?: boolean }
export interface VaultSyncConfiguration { version: 1; vaults: VaultConfiguration[] }

/** Runtime state belongs in host userData, never in the Vault or repository. */
export async function syncConfiguredVaults(
  userData: string, baseUrl: string, current: () => boolean = () => true,
  observe: (result: { id: string; revision: number; uploaded: number; downloaded: number; conflicts: string[] }) => void = () => undefined,
  configure: (vaults: VaultConfiguration[]) => void = () => undefined,
): Promise<void> {
  const configFile = path.join(userData, 'vault-sync.json');
  let config: VaultSyncConfiguration;
  try { config = JSON.parse(await fs.readFile(configFile, 'utf8')); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; config = await bootstrapManagedVaults(userData, baseUrl, new VaultClient(baseUrl)); }
  if (config.version !== 1 || !Array.isArray(config.vaults) || config.vaults.some(vault => !vault || !isVaultId(vault.id) || typeof vault.directory !== 'string' || !path.isAbsolute(vault.directory) || typeof vault.name !== 'string')) throw new Error('INVALID_VAULT_CONFIG');
  if (config.vaults.some(vault => !vault.managed)) config = await migrateManagedVaults(userData, baseUrl, current);
  configure(config.vaults);
  const client = new VaultClient(baseUrl);
  for (const vault of config.vaults) {
    if (!current()) return;
    if (!isVaultId(vault.id) || !path.isAbsolute(vault.directory) || typeof vault.name !== 'string') throw new Error('INVALID_VAULT_CONFIG');
    const directory = vaultReplicaRoot(userData, baseUrl, vault.id);
    const statePath = path.join(directory, 'state.json');
    let state: VaultReplicaState;
    try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; state = emptyVaultReplica(); }
    if (!isVaultReplicaState(state)) throw new Error('INVALID_VAULT_STATE');
    await client.register({ id: vault.id, name: vault.name });
    const disk = new VaultFolder(vault.directory, path.join(directory, 'history'));
    let saves: Promise<void> = Promise.resolve();
    const save = () => {
      saves = saves.then(async () => {
        await fs.mkdir(directory, { recursive: true });
        const temporary = path.join(directory, `state-${randomUUID()}.tmp`);
        try { await fs.writeFile(temporary, JSON.stringify(state)); await fs.rename(temporary, statePath); }
        finally { await fs.unlink(temporary).catch(() => undefined); }
      });
      return saves;
    };
    const result = await syncVault(client, vault.id, disk, state, save, current);
    observe({ id: vault.id, revision: state.cursor, ...result });
  }
}

/** Serial, bounded recovery. Independent HTTP never resets a shared Device Link connection. */
export function createVaultSyncLoop(run: (current: () => boolean) => Promise<void>, onError: (error: unknown) => void) {
  let stopped = false, running = false, requested = false, timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0, retryAt = 0;
  const wake = () => {
    if (stopped) return;
    if (running) { requested = true; return; }
    if (Date.now() < retryAt) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(wake, retryAt - Date.now()); return;
    }
    if (timer) clearTimeout(timer);
    running = true; requested = false;
    void run(() => !stopped).then(() => { failures = 0; }, error => { failures++; onError(error); }).finally(() => {
      running = false;
      const delay = Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4));
      retryAt = failures ? Date.now() + delay : 0;
      if (!stopped) timer = setTimeout(wake, requested && !failures ? 0 : delay);
    });
  };
  return { wake, stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
