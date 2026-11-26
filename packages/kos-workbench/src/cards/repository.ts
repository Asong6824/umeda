import type { VaultSummary } from '@cindy/device-link';
import { displayTitle, parseMetadata, patchMarkdown, splitMarkdown } from '../documents';
import type { ReaderAnchor } from '../reader/model';
import { uniqueId } from '../library/ports';
import type { LibraryModel } from '../library/model';
import { cardRef, contentDigest, parseWhiteboard, type Whiteboard } from './model';

/** Domain operations reuse the existing durable queue and file protocol on both hosts. */
export class CardRepository {
  constructor(readonly library: LibraryModel, readonly vaultId: string) {}
  async createNote(title: string, body = '', extra: Record<string, unknown> = {}) {
    const id = uniqueId(), path = `cards/${id}.md`;
    await this.library.saveText(this.vaultId, path, patchMarkdown('', { ...extra, type: 'card', card_id: id, title, generated_by: extra.generated_by ?? 'human' }, `\n${body}\n`), 0);
    return this.library.files(this.vaultId).find(file => file.path === path)!;
  }
  async createExcerpt(source: VaultSummary, quote: string, location: string, label: string, note: string, anchor?: ReaderAnchor) {
    return this.createNote(`${displayTitle(source)}${label ? ` · ${label}` : ''}`, `> ${quote.replace(/\n/g, '\n> ')}\n\n${note}`, {
      card_kind: 'excerpt', source_card: cardRef(source), source_hash: source.hash, source_location: location, source_label: label, ...(anchor ? { source_anchor: anchor } : {}),
    });
  }
  async createBoard(title: string) {
    const path = `whiteboards/${uniqueId()}.md`;
    const text = patchMarkdown('', { type: 'whiteboard', title }, JSON.stringify({ version: 1, items: [], links: [] }));
    await this.library.saveText(this.vaultId, path, text, 0);
    return this.library.files(this.vaultId).find(file => file.path === path)!;
  }
  async readCurrentText(file: VaultSummary) {
    const latest = () => this.library.files(this.vaultId).find(item => item.path === file.path && !item.deleted) ?? file;
    try { return await this.library.readText(this.vaultId, file.revision === 0 ? latest() : file); }
    catch (error) {
      // A just-created file can be acknowledged between the view snapshot and the
      // host read. Refresh once to replace the revision-zero descriptor, never an
      // empty fallback or an unbounded retry. Offline pending content reads directly.
      if (file.revision !== 0) throw error;
      await this.library.refresh();
      const current = latest();
      if (current.revision === 0) throw error;
      return this.library.readText(this.vaultId, current);
    }
  }
  async readBoard(file: VaultSummary) {
    const latest = this.library.files(this.vaultId).find(item => item.path === file.path && !item.deleted) ?? file;
    return parseWhiteboard(await this.readCurrentText(latest));
  }
  async saveBoard(file: VaultSummary, board: Whiteboard) {
    const latest = this.library.files(this.vaultId).find(item => item.path === file.path && !item.deleted);
    if (!latest) throw new Error('WHITEBOARD_NOT_FOUND');
    const text = await this.readCurrentText(latest);
    // Validate before writing, never repair malformed/future data by replacing it with an empty board.
    parseWhiteboard(text);
    const body = JSON.stringify(board);
    parseWhiteboard(patchMarkdown(text, {}, body));
    const base = latest.revision === 0 ? this.library.files(this.vaultId).find(item => item.path === latest.path)?.revision ?? 0 : latest.revision;
    await this.library.saveText(this.vaultId, latest.path, patchMarkdown(text, {}, body), base);
  }
  async review(file: VaultSummary, text: string) {
    const digest = contentDigest(text);
    const snapshotPath = `90_系统/umeda/reviews/${contentDigest(cardRef(file).id)}-${digest}.md`;
    const existing = this.library.files(this.vaultId).find(item => item.path === snapshotPath && !item.deleted);
    if (existing) {
      if (contentDigest(await this.readCurrentText(existing)) !== digest) throw new Error('REVIEW_SNAPSHOT_MISMATCH');
    } else {
      await this.library.saveText(this.vaultId, snapshotPath, patchMarkdown('', { type: 'review_snapshot', source_card: cardRef(file) }, splitMarkdown(text).body), 0);
    }
    const reviewed = patchMarkdown(text, { kos_reviewed_hash: digest, kos_reviewed_body: snapshotPath, kos_review_pending: false });
    const base = file.revision === 0 ? this.library.files(this.vaultId).find(item => item.path === file.path)?.revision ?? 0 : file.revision;
    await this.library.saveText(this.vaultId, file.path, reviewed, base);
    return reviewed;
  }
  async reviewBase(text: string) {
    const meta = parseMetadata(splitMarkdown(text).frontmatter);
    if (typeof meta.kos_reviewed_body !== 'string' || !meta.kos_reviewed_body.startsWith('90_系统/umeda/reviews/')) return null;
    const file = this.library.files(this.vaultId).find(item => item.path === meta.kos_reviewed_body && !item.deleted);
    if (!file) throw new Error('REVIEW_SNAPSHOT_UNAVAILABLE');
    const accepted = await this.readCurrentText(file);
    if (contentDigest(accepted) !== meta.kos_reviewed_hash) throw new Error('REVIEW_SNAPSHOT_MISMATCH');
    return accepted;
  }
  async keepAccepted(file: VaultSummary, text: string) {
    const accepted = await this.reviewBase(text);
    if (!accepted) throw new Error('REVIEW_SNAPSHOT_UNAVAILABLE');
    const restored = patchMarkdown(text, { kos_review_pending: false }, splitMarkdown(accepted).body);
    await this.library.saveText(this.vaultId, file.path, restored, file.revision);
    return restored;
  }
}
