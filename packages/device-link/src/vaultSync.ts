/** Optional Umeda file sync. Independent of Agent sessions and relay RPC replay. */
export const VAULT_SYNC_FEATURE = 'vault-files-v1';
export const VAULT_INDEX_FEATURE = 'vault-index-v1';
export const VAULT_BATCH_FEATURE = 'vault-index-batch-v1';
export const VAULT_NOTIFY_FEATURE = 'vault-notify-v1';
export const VAULT_LIBRARY_FEATURE = 'vault-library-v1';
export const VAULT_CHANGE_NOTICE = 'umeda:vault-changed';
export function parseVaultChange(value: unknown): { vaultId: string; revision: number } | null {
  if (!value || typeof value !== 'object') return null; const item = value as { vaultId?: unknown; revision?: unknown };
  return isVaultId(item.vaultId) && typeof item.revision === 'number' && Number.isSafeInteger(item.revision) && item.revision > 0 ? { vaultId: item.vaultId, revision: item.revision } : null;
}
export const VAULT_SYNC_PATH = '/api/vaults';
export const VAULT_FILE_MAX_BYTES = 32 * 1024 * 1024;
export interface VaultInfo { id: string; name: string }
export interface VaultFile {
  /** Stable across app-managed moves; absent on legacy relays. */
  documentId?: string;
  aliases?: string[];
  movedTo?: string;
  path: string;
  revision: number;
  hash: string | null;
  size: number;
  modifiedAt: number;
  deleted: boolean;
}
export interface VaultChanges { files: VaultFile[]; cursor: number; more: boolean }
/** Bounded, raw Markdown summary. Parsing and business rules stay in the workbench. */
export interface VaultSummary extends VaultFile { frontmatter: string; excerpt: string; indexError?: 'frontmatter-too-large' | 'frontmatter-unclosed' }
export function isVaultId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value);
}
/** Never mirror runtime settings, credentials, VCS, backups or symlinks. */
export function isVaultPath(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) return false;
  const parts = value.split('/');
  return parts.every(p => !!p && p !== '.' && p !== '..' && !p.startsWith('.'))
    && !parts.some(p => ['node_modules', 'framework-backups'].includes(p))
    && !/\.(?:pem|key|p12|pfx|sqlite|db)(?:$|-)/i.test(value);
}
export class VaultSyncError extends Error {
  constructor(readonly status: number) { super(`VAULT_SYNC_HTTP_${status}`); }
}
export class VaultClient {
  constructor(readonly baseUrl: string, private readonly request: typeof fetch = fetch) {}
  private async call<T>(path: string, consume: (response: Response) => Promise<T>, init?: RequestInit, transferBytes = 0): Promise<T> {
    const controller = new AbortController();
    // Large attachments need a transfer budget; metadata still uses the short fixed budget.
    const timer = setTimeout(() => controller.abort(), 60_000 + Math.ceil(transferBytes / (128 * 1024)) * 1000);
    try {
      const response = await this.request(`${this.baseUrl.replace(/\/$/, '')}${VAULT_SYNC_PATH}${path}`, {
        ...init, signal: controller.signal,
      });
      if (!response.ok) throw new VaultSyncError(response.status);
      return await consume(response);
    } finally { clearTimeout(timer); }
  }
  async list(): Promise<VaultInfo[]> { return this.call('', async response => (await response.json() as { vaults: VaultInfo[] }).vaults); }
  async register(info: VaultInfo): Promise<void> {
    if (!isVaultId(info.id)) throw new Error('INVALID_VAULT_ID');
    await this.call(`/${info.id}`, async response => { await response.arrayBuffer(); }, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: info.name }) });
  }
  async changes(id: string, after = 0): Promise<VaultChanges> {
    if (!isVaultId(id)) throw new Error('INVALID_VAULT_ID');
    return this.call(`/${id}/changes?after=${after}`, async response => {
      const page = await response.json() as VaultChanges;
      if (!page || !Array.isArray(page.files) || page.files.length > 200 || typeof page.more !== 'boolean'
        || !Number.isSafeInteger(page.cursor) || page.cursor < after || (page.more && page.cursor === after)) throw new Error('INVALID_VAULT_MANIFEST');
      let previous = after;
      for (const file of page.files) {
        if (!file || !isVaultPath(file.path) || !Number.isSafeInteger(file.revision) || file.revision <= previous || file.revision > page.cursor
          || typeof file.deleted !== 'boolean' || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > VAULT_FILE_MAX_BYTES
          || !Number.isSafeInteger(file.modifiedAt) || (file.deleted ? file.hash !== null || file.size !== 0 : !/^[a-f0-9]{64}$/.test(file.hash ?? ''))) throw new Error('INVALID_VAULT_MANIFEST');
        previous = file.revision;
      }
      return page;
    });
  }
  private filePath(id: string, path: string): string {
    if (!isVaultId(id) || !isVaultPath(path)) throw new Error('INVALID_VAULT_PATH');
    return `/${id}/file?path=${encodeURIComponent(path)}`;
  }
  async read(id: string, file: VaultFile): Promise<Uint8Array> {
    return this.call(`${this.filePath(id, file.path)}&revision=${file.revision}`, async response => {
      if (Number(response.headers.get('content-length')) > VAULT_FILE_MAX_BYTES) throw new Error('VAULT_FILE_TOO_LARGE');
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== file.size || bytes.length > VAULT_FILE_MAX_BYTES) throw new Error('VAULT_FILE_SIZE_MISMATCH');
      return bytes;
    }, undefined, file.size);
  }
  async write(id: string, path: string, bytes: Uint8Array, baseRevision: number): Promise<VaultFile> {
    if (bytes.length > VAULT_FILE_MAX_BYTES) throw new Error('VAULT_FILE_TOO_LARGE');
    return this.call(this.filePath(id, path), response => response.json(), { method: 'PUT',
      headers: { 'x-vault-base-revision': String(baseRevision) }, body: bytes as unknown as BodyInit }, bytes.length);
  }
  async remove(id: string, path: string, baseRevision: number): Promise<VaultFile> {
    return this.call(this.filePath(id, path), response => response.json(), { method: 'DELETE',
      headers: { 'x-vault-base-revision': String(baseRevision) } });
  }
}

export interface VaultReplicaState {
  version: 1;
  cursor: number;
  remote: Record<string, VaultFile>;
  /** Last agreed version, separate from the latest downloaded cloud manifest. */
  base: Record<string, { revision: number; hash: string | null }>;
}
export const emptyVaultReplica = (): VaultReplicaState => ({ version: 1, cursor: 0, remote: Object.create(null), base: Object.create(null) });
export function isVaultReplicaState(value: unknown): value is VaultReplicaState {
  if (!value || typeof value !== 'object') return false;
  const state = value as VaultReplicaState;
  if (state.version !== 1 || !Number.isSafeInteger(state.cursor) || state.cursor < 0
    || !state.remote || !state.base || typeof state.remote !== 'object' || typeof state.base !== 'object') return false;
  for (const [path, file] of Object.entries(state.remote)) {
    if (!file || file.path !== path || !isVaultPath(path) || !Number.isSafeInteger(file.revision) || file.revision < 1
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > VAULT_FILE_MAX_BYTES || typeof file.deleted !== 'boolean'
      || (file.deleted ? file.hash !== null : !/^[a-f0-9]{64}$/.test(file.hash ?? ''))) return false;
  }
  return Object.entries(state.base).every(([path, base]) => base && isVaultPath(path)
    && Number.isSafeInteger(base.revision) && base.revision >= 0 && (base.hash === null || /^[a-f0-9]{64}$/.test(base.hash))
    && Object.hasOwn(state.remote, path) && state.remote[path].revision >= base.revision);
}
export interface VaultDisk {
  scan(): Promise<Record<string, string>>;
  read(path: string): Promise<Uint8Array>;
  /** Conditional write/remove must preserve displaced bytes outside the synced tree. */
  replace(path: string, bytes: Uint8Array | null, expectedHash: string | null): Promise<void>;
  preserveConflict(path: string, bytes: Uint8Array, hash: string): Promise<string>;
  hash(bytes: Uint8Array): string;
}
export interface VaultSyncResult { uploaded: number; downloaded: number; conflicts: string[] }

/** One pass. Host serializes passes and persists checkpoints after every successful mutation. */
export async function syncVault(
  client: VaultClient, id: string, disk: VaultDisk, state: VaultReplicaState,
  save: () => Promise<void>, current: () => boolean = () => true,
): Promise<VaultSyncResult> {
  const guard = () => { if (!current()) throw new Error('VAULT_SYNC_CANCELLED'); };
  const get = <T>(record: Record<string, T>, key: string): T | undefined => Object.hasOwn(record, key) ? record[key] : undefined;
  const set = <T>(record: Record<string, T>, key: string, value: T) => Object.defineProperty(record, key, { value, configurable: true, enumerable: true, writable: true });
  const result: VaultSyncResult = { uploaded: 0, downloaded: 0, conflicts: [] };
  let more: boolean;
  do {
    guard();
    const changes = await client.changes(id, state.cursor);
    guard();
    for (const file of changes.files) {
      if (!isVaultPath(file.path) || !Number.isSafeInteger(file.revision) || file.revision <= state.cursor
        || file.size < 0 || file.size > VAULT_FILE_MAX_BYTES
        || (!file.deleted && !/^[a-f0-9]{64}$/.test(file.hash ?? ''))) throw new Error('INVALID_VAULT_MANIFEST');
      set(state.remote, file.path, file);
    }
    if (changes.cursor < state.cursor || (changes.more && changes.cursor === state.cursor)) throw new Error('INVALID_VAULT_CURSOR');
    state.cursor = changes.cursor;
    more = changes.more;
    await save();
  } while (more);
  const local = await disk.scan();
  const paths = [...new Set([...Object.keys(local), ...Object.keys(state.remote), ...Object.keys(state.base)])];
  const syncPath = async (path: string) => {
    guard();
    const hash = get(local, path) ?? null, base = get(state.base, path) ?? { revision: 0, hash: null };
    const remote = get(state.remote, path);
    const remoteHash = !remote || remote.deleted ? null : remote.hash;
    const localChanged = hash !== base.hash, remoteChanged = (remote?.revision ?? 0) !== base.revision;
    if (!localChanged && !remoteChanged) return;
    if (remote && hash === remoteHash) {
      set(state.base, path, { revision: remote.revision, hash }); await save(); return;
    }
    if (remoteChanged) {
      // A new device or divergent offline edits: retain the local version as a real synced file.
      if (localChanged && hash) {
        const bytes = await disk.read(path);
        if (disk.hash(bytes) !== hash) throw new Error('VAULT_LOCAL_CHANGED');
        result.conflicts.push(await disk.preserveConflict(path, bytes, hash));
      }
      const bytes = remoteHash ? await client.read(id, remote!) : null;
      guard();
      if (bytes && disk.hash(bytes) !== remoteHash) throw new Error('VAULT_HASH_MISMATCH');
      await disk.replace(path, bytes, hash);
      set(state.base, path, { revision: remote!.revision, hash: remoteHash });
      result.downloaded++;
    } else {
      const bytes = hash ? await disk.read(path) : null;
      if (bytes && disk.hash(bytes) !== hash) throw new Error('VAULT_LOCAL_CHANGED');
      const file = bytes ? await client.write(id, path, bytes, base.revision) : await client.remove(id, path, base.revision);
      guard();
      if (file.hash !== hash || file.path !== path || file.deleted !== !bytes) throw new Error('VAULT_RECEIPT_MISMATCH');
      set(state.remote, path, file);
      set(state.base, path, { revision: file.revision, hash: file.hash });
      result.uploaded++;
    }
    await save();
  };
  // Bound transfer memory and request pressure. Always drain in-flight writes before returning.
  let index = 0, failed = false;
  const worker = async () => {
    while (!failed && index < paths.length) {
      const path = paths[index++];
      try { await syncPath(path); } catch (error) { failed = true; throw error; }
    }
  };
  const workers = await Promise.allSettled(Array.from({ length: Math.min(3, paths.length) }, worker));
  const failure = workers.find((worker): worker is PromiseRejectedResult => worker.status === 'rejected');
  if (failure) throw failure.reason;
  return result;
}
