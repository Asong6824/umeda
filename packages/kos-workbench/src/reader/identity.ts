import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { VaultSummary } from '@cindy/device-link';
import type { LibraryService } from '../library/service';
import { encodeText } from '../library/encoding';
import { mergeReadingStates, type ReadingState } from './state';

export function readerIdentity(vaultId: string, file: VaultSummary) {
  const identity = file.documentId ? `document:${file.documentId}` : file.path;
  const paths = [...new Set([file.path, ...(file.aliases ?? [])])];
  return {
    draftKey: `draft:${vaultId}:${identity}`,
    recordKey: `reading:${vaultId}:${identity}`,
    readingPath: `90_系统/umeda/reading/${bytesToHex(sha256(encodeText(identity)))}.json`,
    legacyDraftKeys: paths.map(path => `draft:${vaultId}:${path}`),
    legacyRecordKeys: paths.map(path => `reading:${vaultId}:${path}`),
    legacyReadingPaths: paths.map(path => `90_系统/umeda/reading/${bytesToHex(sha256(encodeText(path)))}.json`),
  };
}

/** Copy-forward only. Old keys/files remain readable by the previous installed version. */
export async function restoreReaderContext(store: Pick<LibraryService, 'preference' | 'readText'>, vaultId: string, file: VaultSummary, files: VaultSummary[], options: { remote?: boolean } = {}): Promise<{ draft: { text: string; baseRevision: number } | null; record: ReadingState | null }> {
  const identity = readerIdentity(vaultId, file);
  let draft: { text: string; baseRevision: number } | null = null, record: ReadingState | null = null;
  for (const key of [...new Set([identity.draftKey, ...identity.legacyDraftKeys])]) {
    const value = await store.preference<{ text: string; baseRevision: number } | null | { missing: true }>(key, { missing: true });
    if (value === null) break;
    if (!('missing' in value)) { draft = value; break; }
  }
  const merge = (value: ReadingState | null) => {
    if (!value || value.version !== 1 || !Array.isArray(value.annotations)
      || (value.documentId ? value.documentId !== file.documentId : ![file.path, ...(file.aliases ?? [])].includes(value.path))) return;
    const next = { ...value, path: file.path, ...(file.documentId ? { documentId: file.documentId } : {}) };
    const combined = record ? mergeReadingStates(JSON.stringify(record), JSON.stringify(next)) : JSON.stringify(next);
    if (combined) record = JSON.parse(combined) as ReadingState;
  };
  for (const key of [...new Set([identity.recordKey, ...identity.legacyRecordKeys])]) merge(await store.preference<ReadingState | null>(key, null));
  for (const path of options.remote === false ? [] : [...new Set([identity.readingPath, ...identity.legacyReadingPaths])]) {
    const entry = files.find(item => item.path === path);
    if (entry) try { merge(JSON.parse(await store.readText(vaultId, entry))); } catch { /* Keep local records while offline. */ }
  }
  return { draft, record };
}
