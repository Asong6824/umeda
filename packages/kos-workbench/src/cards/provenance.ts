import { parseMetadata, patchMarkdown, splitMarkdown } from '../documents';
import { uniqueId } from '../library/ports';

export class InvalidCardMetadataError extends Error {
  constructor() { super('INVALID_CARD_METADATA'); }
}
/** Host-authored provenance for the new card format. Legacy documents remain byte-compatible. */
export function stampAgentCard(path: string, text: string, previous?: string): string {
  if (!/\.md$/i.test(path) || path.startsWith('90_系统/')) return text;
  let incoming: Record<string, unknown>, old: Record<string, unknown> = {};
  try { old = previous === undefined ? {} : parseMetadata(splitMarkdown(previous).frontmatter); }
  catch { /* A valid replacement can repair malformed historical metadata. */ }
  try {
    incoming = parseMetadata(splitMarkdown(text).frontmatter);
  } catch {
    // Never lose an existing card ID or silently bypass review because an Agent
    // submitted malformed YAML. Legacy non-card writes keep their original behavior.
    if (old.type === 'card' || path.startsWith('cards/')) throw new InvalidCardMetadataError();
    return text;
  }
  if (incoming.type === 'whiteboard' || old.type === 'whiteboard') return text;
  const existingCard = old.type === 'card';
  if (!existingCard && incoming.type !== 'card' && !(previous === undefined && path.startsWith('cards/'))) return text;
  const sameBody = previous !== undefined && splitMarkdown(previous).body === splitMarkdown(text).body;
  return patchMarkdown(text, {
    type: 'card',
    card_id: existingCard && typeof old.card_id === 'string' && old.card_id ? old.card_id
      : typeof incoming.card_id === 'string' && incoming.card_id ? incoming.card_id : uniqueId(),
    generated_by: sameBody && existingCard && ['human', 'ai', 'mixed'].includes(String(old.generated_by)) ? old.generated_by
      : existingCard && old.generated_by !== 'ai' ? 'mixed' : 'ai',
    // The Agent cannot approve its own new prose, even by submitting a matching digest.
    kos_reviewed_hash: typeof old.kos_reviewed_hash === 'string' ? old.kos_reviewed_hash : undefined,
    // Keep the last human-accepted body addressable while a new draft is reviewed.
    kos_reviewed_body: typeof old.kos_reviewed_body === 'string' ? old.kos_reviewed_body : undefined,
    kos_review_pending: !sameBody || old.kos_review_pending === true,
  });
}
