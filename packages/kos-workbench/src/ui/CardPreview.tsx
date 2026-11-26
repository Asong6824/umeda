import { useEffect, useMemo, useRef, useState } from 'react';
import type { VaultSummary } from '@cindy/device-link';
import type { LibraryModel } from '../library/model';
import { loadReaders } from '../reader/load';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { CardRepository } from '../cards/repository';
import { needsReview } from '../cards/model';
import { splitMarkdown, EDIT_MAX_BYTES } from '../documents';
import { t } from '../messages';

export function CardPreview({ store, vaultId, file, page = 1 }: { store: LibraryModel; vaultId: string; file: VaultSummary; page?: number }) {
  const container = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false), [image, setImage] = useState(''), [failed, setFailed] = useState<'unavailable' | 'pageRange' | null>(null), [note, setNote] = useState('');
  const pendingText = store.getSnapshot().pending.findLast(edit => edit.vaultId === vaultId && edit.path === file.path)?.text;
  const text = /\.(md|txt)$/i.test(file.path);
  const pdf = /\.pdf$/i.test(file.path), picture = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.path);
  useEffect(() => {
    if (!container.current || (!pdf && !picture && !text)) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } });
    observer.observe(container.current); return () => observer.disconnect();
  }, [file.path]);
  useEffect(() => {
    if (!visible || (!pdf && !picture && !text)) return;
    let alive = true, dispose = () => {}; setFailed(null); setImage('');
    if (canvas.current) delete canvas.current.dataset.previewReady;
    void (async () => {
      if (text) {
        if (file.size > EDIT_MAX_BYTES) { if (alive) setNote(file.excerpt); return; }
        const repository = new CardRepository(store, vaultId);
        const content = await repository.readCurrentText(file);
        const accepted = needsReview(content) ? await repository.reviewBase(content) : null;
        if (alive) setNote(splitMarkdown(accepted ?? content).body);
        return;
      }
      if (picture && file.size > 8 * 1024 * 1024) throw new Error('PREVIEW_TOO_LARGE');
      const bytes = await store.readBytes(vaultId, file, () => alive);
      if (!alive) return;
      if (pdf) {
        const readers = await loadReaders(); if (!alive || !canvas.current) return;
        const release = await readers.mountPdfPreview(bytes, canvas.current, page, () => alive);
        if (alive) dispose = release; else release();
      } else {
        const ext = file.path.split('.').at(-1)!.toLowerCase();
        const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        const url = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
        dispose = () => URL.revokeObjectURL(url); setImage(url);
      }
    })().catch(error => { if (alive) setFailed(error instanceof Error && error.message === 'PREVIEW_PAGE_OUT_OF_RANGE' ? 'pageRange' : 'unavailable'); });
    return () => { alive = false; dispose(); };
  }, [store, vaultId, visible, file.path, file.hash, file.excerpt, pendingText, page]);
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(note || file.excerpt || '', { async: false }), { FORBID_TAGS: ['script', 'iframe', 'object', 'form', 'style', 'img', 'video', 'audio', 'svg', 'image'], FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false }), [note, file.excerpt]);
  if (!pdf && !picture) return <div ref={container} className="card-note-preview nowheel" onClick={event => { if ((event.target as Element).closest('a')) event.preventDefault(); }} dangerouslySetInnerHTML={{ __html: html }} />;
  return <div ref={container} className="card-rich-preview nodrag nowheel">
    {failed ? <p>{t(failed === 'pageRange' ? 'previewPageOutOfRange' : 'previewUnavailable')}</p> : pdf ? <canvas ref={canvas} aria-label={`${t('pagePreview')} ${page}`} /> : image ? <img src={image} alt={file.path.split('/').at(-1)} /> : <small>{t('processing')}</small>}
  </div>;
}
