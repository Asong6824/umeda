import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { isVaultId, type VaultClient } from '@cindy/device-link';
import { VaultFolder } from './disk';
import type { VaultSyncConfiguration, VaultConfiguration } from './service';
import { withCrossProcessLock } from '../device-link/crossProcessLock';

export function managedVaultRoot(userData: string, baseUrl: string, id: string) {
  if (!isVaultId(id)) throw new Error('INVALID_VAULT_ID');
  const route = createHash('sha256').update(baseUrl).digest('hex');
  return path.join(userData, 'umeda-library', route, id, 'files');
}

export function vaultReplicaRoot(userData: string, baseUrl: string, id: string) {
  if (!isVaultId(id)) throw new Error('INVALID_VAULT_ID');
  return path.join(userData, 'vault-sync', createHash('sha256').update(baseUrl).digest('hex'), id);
}

/** First install only. A malformed/existing explicit configuration is never replaced. */
export async function bootstrapManagedVaults(userData: string, baseUrl: string, client: Pick<VaultClient, 'list' | 'register'>): Promise<VaultSyncConfiguration> {
  const configPath = path.join(userData, 'vault-sync.json');
  try { return JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const remote = await client.list();
  if (!Array.isArray(remote) || remote.some(item => !isVaultId(item.id) || typeof item.name !== 'string')) throw new Error('INVALID_VAULT_CONFIG');
  // A deterministic ID makes concurrent fresh Mac installs converge on one cloud library.
  const vaults = remote.length ? remote : [{ id: 'umeda-default', name: 'Umeda' }];
  const config: VaultSyncConfiguration = { version: 1, vaults: [] };
  for (const info of vaults) {
    const directory = managedVaultRoot(userData, baseUrl, info.id);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    config.vaults.push({ ...info, directory, managed: true });
  }
  if (!remote.length) await client.register(vaults[0]);
  const temporary = path.join(userData, `.umeda-config-${randomUUID()}.tmp`);
  try {
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(config)); await file.sync(); } finally { await file.close(); }
    try { await fs.link(temporary, configPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  } finally { await fs.unlink(temporary).catch(() => undefined); }
  return JSON.parse(await fs.readFile(configPath, 'utf8'));
}

/** Copy/verify only. Caller activates the binding after stopping the original writer. */
export async function stageManagedVault(userData: string, baseUrl: string, source: VaultConfiguration): Promise<VaultConfiguration> {
  const destination = managedVaultRoot(userData, baseUrl, source.id);
  if (path.resolve(source.directory) === path.resolve(destination)) return source;
  const staging = destination + '.import';
  await fs.mkdir(staging, { recursive: true, mode: 0o700 });
  const history = path.join(path.dirname(destination), 'import-history');
  const original = new VaultFolder(source.directory, history);
  let working = staging;
  const manifest = await original.scan();
  const signature = JSON.stringify(Object.entries(manifest).sort());
  const receiptPath = path.join(path.dirname(destination), 'import-receipt.json');
  try {
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    const copied = new VaultFolder(destination, history);
    if (receipt.source !== source.directory || typeof receipt.manifest !== 'string'
      || JSON.stringify(Object.entries(await copied.scan()).sort()) !== receipt.manifest) throw new Error('VAULT_IMPORT_DESTINATION_EXISTS');
    if (receipt.manifest === signature) return { ...source, directory: destination, managed: true };
    working = destination;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const target = new VaultFolder(working, history);
  for (const [relative, hash] of Object.entries(await target.scan()))
    if (!Object.hasOwn(manifest, relative)) await target.replace(relative, null, hash);
  for (const [relative, hash] of Object.entries(manifest)) {
    const bytes = await original.read(relative);
    if (original.hash(bytes) !== hash) throw new Error('VAULT_IMPORT_SOURCE_CHANGED');
    let previous: string | null = null;
    try { previous = target.hash(await target.read(relative)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (previous !== hash) await target.replace(relative, bytes, previous);
  }
  if (JSON.stringify(Object.entries(await original.scan()).sort()) !== JSON.stringify(Object.entries(manifest).sort())) throw new Error('VAULT_IMPORT_SOURCE_CHANGED');
  if (JSON.stringify(Object.entries(await target.scan()).sort()) !== JSON.stringify(Object.entries(manifest).sort())) throw new Error('VAULT_IMPORT_VERIFY_FAILED');
  // Never merge into a pre-existing destination or silently replace its data.
  if (working !== destination) {
    try { await fs.lstat(destination); throw new Error('VAULT_IMPORT_DESTINATION_EXISTS'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const receiptTemporary = receiptPath + '.' + randomUUID();
  await fs.writeFile(receiptTemporary, JSON.stringify({ version: 1, source: source.directory, manifest: signature }), { flag: 'wx', mode: 0o600 });
  await fs.rename(receiptTemporary, receiptPath);
  if (working !== destination) await fs.rename(staging, destination);
  return { ...source, directory: destination, managed: true };
}

/** Serial cutover before a mirror pass; the old source and original configuration are retained. */
export async function migrateManagedVaults(userData: string, baseUrl: string, current: () => boolean): Promise<VaultSyncConfiguration> {
  return withCrossProcessLock(path.join(userData, 'umeda-library-migration.lock'), { label: 'umeda-library-migration', waitMs: 0 }, async lock => {
    if (!lock.held) throw new Error('VAULT_IMPORT_BUSY');
    const configPath = path.join(userData, 'vault-sync.json'), raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as VaultSyncConfiguration;
    if (!config.vaults.some(vault => !vault.managed)) return config;
    const vaults: VaultConfiguration[] = [];
    for (const vault of config.vaults) {
      if (!current()) throw new Error('VAULT_IMPORT_INTERRUPTED');
      vaults.push(vault.managed ? vault : await stageManagedVault(userData, baseUrl, vault));
    }
    for (let index = 0; index < config.vaults.length; index++) {
      const source = config.vaults[index];
      if (source.managed) continue;
      const original = new VaultFolder(source.directory, path.join(userData, 'umeda-import-unused-history'));
      const copied = new VaultFolder(vaults[index].directory, path.join(userData, 'umeda-import-unused-history'));
      if (JSON.stringify(Object.entries(await original.scan()).sort()) !== JSON.stringify(Object.entries(await copied.scan()).sort())) throw new Error('VAULT_IMPORT_SOURCE_CHANGED');
    }
    if (!current() || await fs.readFile(configPath, 'utf8') !== raw) throw new Error('VAULT_IMPORT_CONFIGURATION_CHANGED');
    const backup = path.join(userData, `vault-sync.before-managed-${randomUUID()}.json`);
    await fs.writeFile(backup, raw, { flag: 'wx', mode: 0o600 });
    const next = { ...config, vaults }, temporary = configPath + '.' + randomUUID() + '.tmp';
    try {
      const file = await fs.open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(next)); await file.sync(); } finally { await file.close(); }
      if (!current() || await fs.readFile(configPath, 'utf8') !== raw) throw new Error('VAULT_IMPORT_CONFIGURATION_CHANGED');
      await fs.rename(temporary, configPath);
    } finally { await fs.unlink(temporary).catch(() => undefined); }
    return next;
  });
}
