import type { ReaderAnnotation, ReaderProgress } from './model';
export interface ReadingState { version: 1; path: string; documentId?: string; documentHash: string | null; progress?: ReaderProgress; annotations: ReaderAnnotation[]; deleted: Record<string, string> }
function parse(value: string): ReadingState | null {
  try {
    const record = JSON.parse(value) as ReadingState;
    if (record?.version !== 1 || typeof record.path !== 'string' || !Array.isArray(record.annotations) || !record.deleted || typeof record.deleted !== 'object'
      || record.annotations.some(annotation => typeof annotation.id !== 'string' || typeof annotation.updatedAt !== 'string' || typeof annotation.text !== 'string')) return null;
    return record;
  } catch { return null; }
}
/** User notes merge by stable IDs. Tombstones prevent an offline device restoring deleted marks. */
export function mergeReadingStates(local: string, remote: string): string | null {
  const a = parse(local), b = parse(remote);
  if (!a || !b || (a.documentId && b.documentId ? a.documentId !== b.documentId : a.path !== b.path)) return null;
  const annotations = new Map<string, ReaderAnnotation>(), deleted: Record<string, string> = Object.create(null);
  for (const record of [b, a]) {
    for (const annotation of record.annotations) {
      const previous = annotations.get(annotation.id);
      if (!previous || annotation.updatedAt >= previous.updatedAt) annotations.set(annotation.id, annotation);
    }
    for (const [id, date] of Object.entries(record.deleted)) if (typeof date === 'string' && (!Object.hasOwn(deleted, id) || date > deleted[id])) deleted[id] = date;
  }
  const newest = (a.progress?.updatedAt ?? '') >= (b.progress?.updatedAt ?? '') ? a : b;
  return JSON.stringify({ ...newest, annotations: [...annotations.values()].filter(annotation => !Object.hasOwn(deleted, annotation.id) || annotation.updatedAt > deleted[annotation.id]), deleted }, null, 2);
}
