import type { VaultSummary } from '@cindy/device-link';
import type { LibraryModel } from '../library/model';
import { loadReaders } from './load';

/** Optional view-owned derivation; accepted text and index metadata belong to the host. */
export async function indexBook(store: LibraryModel, vaultId: string, file: VaultSummary, signal: AbortSignal, progress: (count: number) => void) {
  const kind = /\.pdf$/i.test(file.path) ? 'pdf' : /\.epub$/i.test(file.path) ? 'epub' : null;
  if (!kind) throw new Error('INVALID_BOOK_INDEX');
  const bytes = await store.readBytes(vaultId, file, () => !signal.aborted), readers = await loadReaders();
  let count = 0;
  for await (const part of readers.extractBookText(bytes, kind, signal)) {
    if (signal.aborted) throw new DOMException('Indexing stopped', 'AbortError');
    await store.indexBookPart(vaultId, file, count++, part); progress(count);
  }
  if (signal.aborted) throw new DOMException('Indexing stopped', 'AbortError');
  await store.completeBookIndex(vaultId, file, count);
}
