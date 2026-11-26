import AsyncStorage from '@react-native-async-storage/async-storage';
import { Directory, File, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { VaultClient, type VaultFile, type VaultInfo } from '@cindy/device-link';
import { getActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { vaultStorageScope } from './scope';

export interface VaultCatalog { vaults: VaultInfo[]; files: Record<string, VaultFile[]>; cursors?: Record<string, number>; updatedAt: number }
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));

/** A route-scoped offline reader. No Agent or Mac connection is required. */
export function createMobileVaultReader() {
  const route = getActiveSelfHostedRelay(), owner = getMobileAuthOwner();
  if (!route || route.authMode !== 'none') throw new Error('VAULT_ROUTE_UNAVAILABLE');
  const scope = vaultStorageScope(owner.accountKey, route);
  const key = `umeda.vault.catalog.v1.${scope}`;
  const client = new VaultClient(route.baseUrl);
  const guard = () => {
    const active = getActiveSelfHostedRelay();
    if (!isMobileAuthOwnerCurrent(owner) || active?.baseUrl !== route.baseUrl || active.relayId !== route.relayId) throw new Error('VAULT_ROUTE_CHANGED');
  };
  const cached = async (): Promise<VaultCatalog> => {
    guard(); const raw = await AsyncStorage.getItem(key); guard();
    if (raw) try {
      const catalog = JSON.parse(raw) as VaultCatalog;
      if (Array.isArray(catalog.vaults) && catalog.files && typeof catalog.files === 'object') return catalog;
    } catch { /* Rebuild disposable metadata cache; downloaded files remain untouched. */ }
    return { vaults: [], files: {}, updatedAt: 0 };
  };
  return {
    cached,
    async refresh(): Promise<VaultCatalog> {
      guard();
      const previous = await cached();
      const vaults = await client.list(); guard();
      const files: Record<string, VaultFile[]> = Object.create(null);
      const cursors: Record<string, number> = Object.create(null);
      // Incremental metadata only; document bytes and attachments are fetched on demand.
      for (const vault of vaults) {
        let cursor = previous.cursors && Object.hasOwn(previous.cursors, vault.id) ? previous.cursors[vault.id] : 0, more: boolean;
        const entries = new Map((Object.hasOwn(previous.files, vault.id) ? previous.files[vault.id] : []).map(file => [file.path, file]));
        do {
          const page = await client.changes(vault.id, cursor); guard();
          if (page.more && page.cursor <= cursor) throw new Error('INVALID_VAULT_CURSOR');
          for (const file of page.files) {
            if (file.deleted) entries.delete(file.path); else entries.set(file.path, file);
          }
          cursor = page.cursor; more = page.more;
        } while (more);
        files[vault.id] = [...entries.values()].sort((a, b) => a.path.localeCompare(b.path));
        cursors[vault.id] = cursor;
      }
      const catalog = { vaults, files, cursors, updatedAt: Date.now() };
      guard(); await AsyncStorage.setItem(key, JSON.stringify(catalog)); guard();
      return catalog;
    },
    async read(id: string, entry: VaultFile): Promise<{ bytes: Uint8Array; uri: string }> {
      guard();
      if (!/^[a-f0-9]{64}$/.test(entry.hash ?? '')) throw new Error('INVALID_VAULT_HASH');
      const directory = new Directory(Paths.document, 'umeda-vault', scope);
      directory.create({ intermediates: true, idempotent: true });
      const extension = /\.([a-z0-9]{1,10})$/i.exec(entry.path)?.[1] ?? 'bin';
      const file = new File(directory, `${entry.hash}.${extension}`);
      if (file.exists) {
        const bytes = await file.bytes(); guard();
        if (digest(bytes) === entry.hash) return { bytes, uri: file.uri };
        file.delete();
      }
      const bytes = await client.read(id, entry); guard();
      if (digest(bytes) !== entry.hash) throw new Error('VAULT_HASH_MISMATCH');
      file.write(bytes); guard();
      return { bytes, uri: file.uri };
    },
  };
}
