import type { VaultInfo, VaultSummary } from '@cindy/device-link';
import type { LibraryService } from './service';
import { summaryFromText } from '../documents';
import { encodeText } from './encoding';
export interface PendingEdit {
  id: string;
  vaultId: string;
  path: string;
  text: string;
  baseRevision: number;
  createdAt: number;
}
export interface Catalog {
  identityVersion?: number;
  capabilities?: string[];
  trash?: Record<string, VaultSummary[]>;
  vaults: VaultInfo[];
  files: Record<string, VaultSummary[]>;
  cursors: Record<string, number>;
  updatedAt: number;
}
export interface PendingMove {
  id: string;
  vaultId: string;
  from: string;
  to: string;
  documentId: string;
  baseRevision: number;
  file: VaultSummary;
  status: 'pending' | 'conflict';
  attempted?: boolean;
}
export interface StorageReport { cacheBytes: number; pendingBytes: number; pinnedBytes: number; cacheOnlyBytes: number; objects: number }
export interface BookTextPart { text: string; location: string; label: string }
export interface BookIndex { parts: Array<{ location: string; label: string }>; complete: boolean; bytes: number }
export interface BookIndexSummary { count: number; complete: boolean; bytes: number }
export interface WorkbenchSnapshot {
  bookIndexes?: Record<string, BookIndexSummary>;
  moves?: PendingMove[];
  downloads?: OfflineFile[];
  serviceId?: string;
  sequence?: number;
  catalog: Catalog;
  pending: PendingEdit[];
  loading: boolean;
  offline: boolean;
  error: string | null;
  conflicts: string[];
  progress: number;
}
export interface OfflineFile { vaultId: string; path: string; documentId?: string; hash?: string; status: 'pending' | 'ready' | 'error' }
export interface SearchResults { hits: Array<{ file: VaultSummary; snippet: string; location?: string; label?: string }>; covered: number; total: number; more: boolean }

export type LibraryModel = Pick<LibraryService, 'host' | 'subscribe' | 'getSnapshot' | 'ready' | 'initialize' | 'refresh' | 'files' | 'readText' | 'readBytes' | 'saveText' | 'preference' | 'savePreference' | 'capture' | 'watch' | 'history' | 'readVersion' | 'restore' | 'move' | 'cancelMove' | 'retryMove' | 'storageReport' | 'indexBookPart' | 'completeBookIndex' | 'dispose' | 'search' | 'pinOffline' | 'cancelOffline'>;

export function filesFromSnapshot(snapshot: WorkbenchSnapshot, vaultId: string): VaultSummary[] {
    const files = new Map(
      (Object.hasOwn(snapshot.catalog.files, vaultId)
        ? snapshot.catalog.files[vaultId]
        : []
      ).map((file) => [file.path, file]),
    );
    for (const edit of snapshot.pending.filter((edit) => edit.vaultId === vaultId)) {
      const current = files.get(edit.path) ?? {
        path: edit.path,
        revision: 0,
        hash: null,
        size: 0,
        modifiedAt: edit.createdAt,
        deleted: false,
        frontmatter: '',
        excerpt: '',
      };
      files.set(edit.path, {
        ...summaryFromText(current, edit.text),
        size: encodeText(edit.text).length,
      });
    }
    for (const move of snapshot.moves ?? []) {
      if (move.vaultId !== vaultId || move.status === 'conflict') continue;
      const source = files.get(move.from);
      const target = files.get(move.to);
      if (target && target.documentId !== move.documentId) continue;
      // A reused source path is another document. Never hide it behind an old operation.
      if (source && source.documentId !== move.documentId) continue;
      if (source) files.delete(move.from);
      const original = source ?? target ?? move.file;
      files.set(move.to, { ...original, path: move.to, aliases: [...new Set([...(original.aliases ?? []), move.from])].filter(path => path !== move.to) });
    }
    return [...files.values()];
  }
