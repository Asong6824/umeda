import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { VaultSummary, VaultFile } from '@cindy/device-link';
import { filesFromSnapshot, type LibraryModel, type WorkbenchSnapshot, type SearchResults, type StorageReport, type BookTextPart } from './model';
import { fromBase64 } from './encoding';
import type { LibraryRequest } from './rpc';
import type { WorkbenchHost } from './ports';

/** A view projection. Durable state and delivery belong to the host service. */
export class LibraryClient implements LibraryModel {
  private view: WorkbenchSnapshot = { catalog: { vaults: [], files: {}, cursors: {}, updatedAt: 0 }, pending: [], loading: true, offline: false, error: null, conflicts: [], progress: 0 };
  private views = new Set<() => void>();
  private loaded: Promise<void> | null = null;
  private closed = false;
  constructor(readonly host: WorkbenchHost, receive: (listener: (snapshot: WorkbenchSnapshot) => void) => () => void) {
    this.detach = receive(snapshot => this.accept(snapshot));
  }
  private detach: () => void;
  private accept(snapshot: WorkbenchSnapshot) {
    if (this.closed || (snapshot.serviceId && snapshot.serviceId === this.view.serviceId && snapshot.sequence !== undefined && snapshot.sequence <= (this.view.sequence ?? -1))) return;
    this.view = snapshot;
    for (const listener of this.views) listener();
  }
  private command<T>(command: LibraryRequest['command'], args?: Record<string, unknown>) {
    return this.host.call<T>('library', { command, args });
  }
  subscribe = (listener: () => void) => { this.views.add(listener); return () => { this.views.delete(listener); }; };
  getSnapshot = () => this.view;
  ready(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('LIBRARY_VIEW_CLOSED'));
    return this.loaded ??= this.command<WorkbenchSnapshot>('ready').then(snapshot => { this.accept(snapshot); }).catch(error => { this.loaded = null; throw error; });
  }
  async initialize() { await this.ready(); }
  async search(vaultId: string, query: string) { await this.ready(); return this.command<SearchResults>('search', { vaultId, query }); }
  async pinOffline(vaultId: string, path?: string) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('pinOffline', { vaultId, path })); }
  async cancelOffline(vaultId: string, path: string) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('cancelOffline', { vaultId, path })); }
  async refresh() { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('refresh')); }
  files(vaultId: string) { return filesFromSnapshot(this.view, vaultId); }
  async readText(vaultId: string, file: VaultSummary) { await this.ready(); return this.command<string>('readText', { vaultId, file }); }
  async saveText(vaultId: string, path: string, text: string, baseRevision: number) {
    await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('saveText', { vaultId, path, text, baseRevision }));
  }
  async preference<T>(key: string, fallback: T) { await this.ready(); return this.command<T>('preference', { key, fallback }); }
  async savePreference(key: string, value: unknown) { await this.ready(); await this.command<void>('savePreference', { key, value }); }
  async capture(vaultId: string, title: string, body: string) { await this.ready(); return this.command<string>('capture', { vaultId, title, body }); }
  watch() { return () => {}; }
  async history(vaultId: string, path: string, before?: number) { await this.ready(); return this.command<{ files: VaultFile[]; more: boolean; indexing?: boolean; indexCursor?: string }>('history', { vaultId, path, before }); }
  async readVersion(vaultId: string, file: VaultFile) { await this.ready(); return this.command<string>('readVersion', { vaultId, file }); }
  async restore(vaultId: string, path: string, revision: number, baseRevision: number) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('restore', { vaultId, path, revision, baseRevision })); }
  async cancelMove(vaultId: string, id: string) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('cancelMove', { vaultId, id })); }
  async retryMove(vaultId: string, id: string) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('retryMove', { vaultId, id })); }
  async storageReport() { await this.ready(); return this.command<StorageReport | null>('storageReport'); }
  async indexBookPart(vaultId: string, file: VaultSummary, position: number, part: BookTextPart) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('indexBookPart', { vaultId, file, position, part })); }
  async completeBookIndex(vaultId: string, file: VaultSummary, count: number) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('completeBookIndex', { vaultId, file, count })); }
  async move(vaultId: string, path: string, to: string, baseRevision: number) { await this.ready(); this.accept(await this.command<WorkbenchSnapshot>('move', { vaultId, path, to, baseRevision })); }
  async readBytes(vaultId: string, file: VaultSummary, current: () => boolean = () => true) {
    await this.ready();
    if (!file.hash || file.size > 32 * 1024 * 1024) throw new Error('INVALID_LIBRARY_FILE');
    const bytes = new Uint8Array(file.size);
    for (let offset = 0; offset < file.size; offset += 256 * 1024) {
      if (!current()) throw new DOMException('Reader closed', 'AbortError');
      const data = fromBase64(await this.command<string>('readBinaryPart', { vaultId, file, offset }));
      if (!current()) throw new DOMException('Reader closed', 'AbortError');
      if (data.length !== Math.min(256 * 1024, file.size - offset)) throw new Error('INVALID_BINARY_RANGE');
      bytes.set(data, offset);
    }
    if (bytesToHex(sha256(bytes)) !== file.hash) throw new Error('VAULT_HASH_MISMATCH');
    return bytes;
  }
  dispose() { this.closed = true; this.detach(); this.views.clear(); }
}
