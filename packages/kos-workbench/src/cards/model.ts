import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { VaultSummary } from '@cindy/device-link';
import { isVaultPath } from '@cindy/device-link';
import { displayTitle, parseMetadata, splitMarkdown } from '../documents';

export interface CardRef { id: string; path: string }
export interface Card { ref: CardRef; file: VaultSummary; title: string; kind: 'note' | 'excerpt' | 'material'; tags: string[]; ai: boolean }
export interface Placement {
  id: string; kind: 'card' | 'text' | 'section'; x: number; y: number; width: number; height: number;
  card?: CardRef; text?: string; folded?: boolean; previewPage?: number; aiRequest?: string;
}
export interface BoardLink { id: string; from: string; to: string; label?: string }
export interface Whiteboard { version: 1; items: Placement[]; links: BoardLink[] }
export function metadataOf(file: VaultSummary): Record<string, unknown> {
  try { return parseMetadata(file.frontmatter); } catch { return {}; }
}
export function isWhiteboard(file: VaultSummary) { return metadataOf(file).type === 'whiteboard'; }
export function cardRef(file: VaultSummary): CardRef {
  const id = metadataOf(file).card_id;
  return { id: typeof id === 'string' && id ? `card:${id}` : file.documentId ? `document:${file.documentId}` : `path:${file.path}`, path: file.path };
}
export function resolveCard(ref: CardRef, files: VaultSummary[]): VaultSummary | undefined {
  const live = files.filter(file => !file.deleted);
  // A reused path must never substitute another document for an identified card.
  if (!ref.id.startsWith('path:')) return live.find(file => cardRef(file).id === ref.id);
  const aliases = live.filter(file => file.path === ref.path || file.aliases?.includes(ref.path));
  return aliases.length === 1 ? aliases[0] : undefined;
}
export function cardsFromFiles(files: VaultSummary[]): Card[] {
  return files.filter(file => !file.deleted && !file.path.startsWith('90_系统/') && !isWhiteboard(file))
    .filter(file => !['goal', 'project', 'task', 'dashboard'].includes(String(metadataOf(file).type)))
    .map(file => {
      const meta = metadataOf(file);
      return { ref: cardRef(file), file, title: displayTitle(file),
        kind: meta.card_kind === 'excerpt' || meta.type === 'extract' ? 'excerpt' : /\.(md|txt)$/i.test(file.path) && meta.type !== 'source' ? 'note' : 'material',
        tags: Array.isArray(meta.tags) ? meta.tags.filter((tag): tag is string => typeof tag === 'string') : [],
        ai: ['ai', 'mixed'].includes(String(meta.generated_by ?? meta.extracted_by)) || meta.claim_status === 'agent_claim',
      };
    });
}
/** Content-only digest: moving a card or changing tags never invalidates its review. */
export function contentDigest(text: string) { return bytesToHex(sha256(new TextEncoder().encode(splitMarkdown(text).body))); }
export function needsReview(text: string): boolean {
  const meta = parseMetadata(splitMarkdown(text).frontmatter);
  const ai = ['ai', 'mixed'].includes(String(meta.generated_by ?? meta.extracted_by)) || meta.claim_status === 'agent_claim';
  return ai && meta.kos_reviewed_hash !== contentDigest(text);
}
export function parseWhiteboard(text: string): Whiteboard {
  const value = JSON.parse(splitMarkdown(text).body) as Whiteboard;
  if (value.version !== 1 || !Array.isArray(value.items) || !Array.isArray(value.links)) throw new Error('INVALID_WHITEBOARD');
  const ids = new Set<string>();
  for (const item of value.items) {
    if (!item || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !['card', 'text', 'section'].includes(item.kind)
      || ![item.x, item.y, item.width, item.height].every(Number.isFinite) || item.width < 80 || item.height < 40
      || (item.previewPage !== undefined && (!Number.isSafeInteger(item.previewPage) || item.previewPage < 1))
      || (item.aiRequest !== undefined && typeof item.aiRequest !== 'string')
      || (item.text !== undefined && typeof item.text !== 'string')
      || (item.kind === 'card' && (!item.card || typeof item.card.id !== 'string' || !isVaultPath(item.card.path)))) throw new Error('INVALID_WHITEBOARD');
    ids.add(item.id);
  }
  const edges = new Set<string>();
  for (const link of value.links) {
    if (!link || typeof link.id !== 'string' || edges.has(link.id) || !ids.has(link.from) || !ids.has(link.to)
      || (link.label !== undefined && typeof link.label !== 'string')) throw new Error('INVALID_WHITEBOARD');
    edges.add(link.id);
  }
  return value;
}
