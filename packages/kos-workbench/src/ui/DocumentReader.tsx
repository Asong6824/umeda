import { useEffect, useRef, useState } from 'react';
import type { VaultSummary } from '@cindy/device-link';
import type { LibraryModel as WorkbenchStore } from '../library/model';
import { encodeText } from '../library/encoding';
import { displayTitle, EDIT_MAX_BYTES, parseMetadata, patchMarkdown, resolveReference, splitMarkdown } from '../documents';
import type { ReaderAdapterHandle, ReaderAdapterState, ReaderAnnotation, ReaderAnnotationColor, ReaderSelection } from '../reader/model';
import { MarkdownReaderAdapter } from '../reader/adapters/markdown-adapter';
import { loadReaders } from '../reader/load';
import { TASK_STATUSES, PROJECT_STATUSES, GOAL_STATUSES, SOURCE_STATUSES, KNOWLEDGE_STATUSES } from '../core/model';
import { t, stateLabel } from '../messages';
import { uniqueId, beforeLeave } from '../host';
import { useModalDialog } from './useModalDialog';
import { Icon } from './Icons';
import { mergeReadingStates, type ReadingState } from '../reader/state';
import { readerIdentity, restoreReaderContext } from '../reader/identity';
import { CardRepository } from '../cards/repository';
import { needsReview, resolveCard } from '../cards/model';
import { ReviewChanges } from './ReviewChanges';
import { VersionHistory } from './VersionHistory';

const EMPTY_READER: ReaderAdapterState = { location: '', progress: null, positionLabel: '', canNext: false, canPrevious: false, toc: [] };
export function DocumentReader({ store, vaultId, file, files, startEditing, initialLocation, onClose, onOpen, notice, embedded = false }: {
  store: WorkbenchStore; vaultId: string; file: VaultSummary; files: VaultSummary[]; startEditing: boolean; embedded?: boolean; initialLocation?: string; onClose(): void; onOpen(file: VaultSummary, location?: string): void; notice(message: string): void;
}) {
  const [acceptedText, setAcceptedText] = useState<string | null>(null), [showChanges, setShowChanges] = useState(false);
  const [text, setText] = useState<string | null>(null), [draft, setDraft] = useState(''), [editing, setEditing] = useState(startEditing), [rawMode, setRawMode] = useState(false);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false), [draftBase, setDraftBase] = useState(file.revision);
  const [readerState, setReaderState] = useState(EMPTY_READER), [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [panel, setPanel] = useState<'toc' | 'search' | 'notes' | 'history' | null>(null), [query, setQuery] = useState(''), [results, setResults] = useState<Array<{ id: string; excerpt: string; location: string }>>([]);
  const [note, setNote] = useState(''), [color, setColor] = useState<ReaderAnnotationColor>('yellow'), [fontSize, setFontSize] = useState(17);
  const [record, setRecord] = useState<ReadingState>({ version: 1, path: file.path, documentId: file.documentId, documentHash: file.hash, annotations: [], deleted: {} });
  const hostRef = useRef<HTMLElement>(null), handle = useRef<ReaderAdapterHandle | null>(null), currentRecord = useRef(record);
  const restoringRecord = useRef(true), readerTouched = useRef(!!initialLocation);
  currentRecord.current = record;
  const { readingPath, draftKey, recordKey } = readerIdentity(vaultId, file);
  const readingFile = files.find(item => item.path === readingPath), recordRevision = useRef(readingFile?.revision ?? 0);
  const excerptLock = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), localTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isImage = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.path);
  const isText = /\.(md|txt|json|ya?ml|csv)$/i.test(file.path), isPdf = /\.pdf$/i.test(file.path), isEpub = /\.epub$/i.test(file.path);
  const saveRecord = async (next: ReadingState, cloud: boolean) => {
    await store.savePreference(recordKey, next);
    if (cloud) await store.saveText(vaultId, readingPath, JSON.stringify(next, null, 2), recordRevision.current);
  };
  const persistRecord = async (next: ReadingState, cloud = false) => {
    currentRecord.current = next; setRecord(next);
    clearTimeout(localTimer.current); clearTimeout(timer.current);
    if (cloud) await saveRecord(next, true);
    else {
      localTimer.current = setTimeout(() => { void saveRecord(currentRecord.current, false).catch(() => notice(t('saveError'))); }, 300);
      timer.current = setTimeout(() => { void saveRecord(currentRecord.current, true).catch(() => notice(t('saveError'))); }, 10_000);
    }
  };
  const draftRef = useRef({ draft, draftBase, editing, text }); draftRef.current = { draft, draftBase, editing, text };
  useEffect(() => beforeLeave(async () => {
    const current = draftRef.current;
    if (current.editing && current.draft !== current.text) await store.savePreference(draftKey, { text: current.draft, baseRevision: current.draftBase });
    if (currentRecord.current.progress || currentRecord.current.annotations.length) await saveRecord(currentRecord.current, true);
  }), [store, vaultId, file.path]);
  useEffect(() => {
    let alive = true;
    const read = async () => {
      const { record: next, draft: cachedDraft } = await restoreReaderContext(store, vaultId, file, files, { remote: false });
      if (next?.version === 1 && Array.isArray(next.annotations)) { currentRecord.current = next; if (alive) setRecord(next); }
      const value = isText ? await new CardRepository(store, vaultId).readCurrentText(file) : null;
      if (alive) {
        setText(value); setDraft(cachedDraft?.text ?? value ?? ''); setDraftBase(cachedDraft?.baseRevision ?? (file.revision === 0 ? store.files(vaultId).find(item => item.path === file.path)?.revision ?? 0 : file.revision));
        if (cachedDraft) { setEditing(true); notice(t('draftRestored')); }
      }
      const cachedFont = await store.preference('reader-font', 17); if (alive) setFontSize(cachedFont);
      // A remote annotation/version check must not hold already cached text behind the network.
      void restoreReaderContext(store, vaultId, file, files).then(({ record: remote }) => {
        if (!alive || !remote) return;
        const merged = mergeReadingStates(JSON.stringify(currentRecord.current), JSON.stringify(remote));
        if (!merged) return;
        const next = JSON.parse(merged) as ReadingState;
        currentRecord.current = next; setRecord(next);
        void handle.current?.setAnnotations(next.annotations);
        if (!readerTouched.current && next.progress?.location) void handle.current?.goTo(next.progress.location);
      }).finally(() => { if (alive) restoringRecord.current = false; }).catch(() => undefined);
    };
    void read().catch(error => { if (alive) setError(error instanceof Error ? error.message : t('readError')); }).finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false; clearTimeout(timer.current); clearTimeout(localTimer.current);
      if (currentRecord.current.progress || currentRecord.current.annotations.length) {
        void store.savePreference(recordKey, currentRecord.current);
        void store.saveText(vaultId, readingPath, JSON.stringify(currentRecord.current, null, 2), recordRevision.current).catch(() => undefined);
      }
    };
  }, [file.path, store, vaultId]);
  const mergedRevision = useRef(readingFile?.revision ?? 0);
  useEffect(() => {
    if (loading || !readingFile || readingFile.revision === mergedRevision.current) return;
    let alive = true;
    void store.readText(vaultId, readingFile).then(remote => {
      if (!alive) return;
      const merged = mergeReadingStates(JSON.stringify(currentRecord.current), remote);
      if (!merged) return;
      mergedRevision.current = readingFile.revision; recordRevision.current = readingFile.revision;
      const next = JSON.parse(merged) as ReadingState; currentRecord.current = next; setRecord(next);
      void store.savePreference(recordKey, next).catch(() => notice(t('saveError')));
      void handle.current?.setAnnotations(next.annotations);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [store, vaultId, loading, readingFile?.revision]);
  useEffect(() => {
    if (!editing || loading || !isText) return;
    const timer = setTimeout(() => { void store.savePreference(draftKey, { text: draft, baseRevision: draftBase }).catch(() => notice(t('saveError'))); }, 300);
    return () => clearTimeout(timer);
  }, [store, editing, loading, draft, draftBase, draftKey, isText]);
  useEffect(() => {
    let alive = true; setAcceptedText(null);
    if (text !== null) void Promise.resolve().then(() => needsReview(text) ? new CardRepository(store, vaultId).reviewBase(text) : null).then(value => { if (alive) setAcceptedText(value); }).catch(() => { if (alive) notice(t('reviewBaseUnavailable')); });
    return () => { alive = false; };
  }, [store, vaultId, text]);
  useEffect(() => {
    if (loading || editing || !hostRef.current || error) return;
    let alive = true, mounted: ReaderAdapterHandle | null = null;
    // Each asynchronous mount owns its container. A late close from the previous
    // accepted/proposed version must never clear the new reader's contents.
    const host = document.createElement('div'); host.className = 'reader-adapter-host';
    hostRef.current.replaceChildren(host);
    const mount = async () => {
      let adapter;
      const imageUrl = async (reference: string) => {
        const image = resolveReference(reference, file.path, files);
        if (!image || !/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(image.path) || image.size > 8 * 1024 * 1024) return null;
        const bytes = await store.readBytes(vaultId, image, () => alive), ext = image.path.split('.').at(-1)?.toLowerCase();
        const type = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        return URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
      };
      if (isImage) {
        const url = await imageUrl(file.path);
        if (!alive) { if (url) URL.revokeObjectURL(url); return; }
        if (!url) throw new Error(t('readError'));
        const image = document.createElement('img'); image.src = url; image.alt = displayTitle(file); image.className = 'reader-image'; host.append(image);
        mounted = { previous: async () => {}, next: async () => {}, goTo: async () => {}, search: async () => [], setAnnotations: async () => {}, getContext: async () => ({ text: '', location: '', positionLabel: '' }), close: () => { URL.revokeObjectURL(url); host.replaceChildren(); } }; handle.current = mounted; return;
      }
      if (!isText && !isPdf && !isEpub) throw new Error(t('unsupportedFormat'));
      if (isPdf || isEpub) {
        const { PdfReaderAdapter, EpubReaderAdapter } = await loadReaders(); if (!alive) return;
        const bytes = await store.readBytes(vaultId, file, () => alive); if (!alive) return;
        const app = { vault: { readBinary: async () => bytes.slice().buffer } };
        adapter = isPdf ? new PdfReaderAdapter(app, { path: file.path }) : new EpubReaderAdapter(app, { path: file.path });
      } else adapter = new MarkdownReaderAdapter(acceptedText && !showChanges ? acceptedText : text ?? '', reference => {
        const target = resolveReference(reference, file.path, files);
        if (target) onOpen(target); else if (/^https:\/\//i.test(reference)) void store.host.call('openExternal', { url: reference });
        else if (reference.startsWith('#')) host.querySelector(`#${CSS.escape(reference.slice(1))}`)?.scrollIntoView();
      }, imageUrl);
      const instance = await adapter.mount({ container: host, initialLocation: initialLocation ?? currentRecord.current.progress?.location, annotations: currentRecord.current.annotations,
        onSelection: selection => { if (alive && (selection || !document.activeElement?.closest('.selection-toolbar'))) setSelection(selection); },
        onState: state => { if (!alive) return; setReaderState(state); if (state.location && (!restoringRecord.current || readerTouched.current)) void persistRecord({ ...currentRecord.current, progress: { kind: isPdf ? 'pdf' : isEpub ? 'epub' : 'markdown', location: state.location, progress: state.progress, updatedAt: new Date().toISOString() } }); },
      });
      if (!alive) { await instance.close(); return; } mounted = instance; handle.current = instance;
    };
    void mount().catch(error => { if (alive) setError(error instanceof Error ? error.message : t('readError')); });
    return () => { alive = false; handle.current = null; if (mounted) void mounted.close(); host.remove(); };
  }, [loading, editing, file.path, text, error, acceptedText, showChanges]);
  const save = async () => {
    setBusy(true); setError('');
    try {
      if (encodeText(draft).length > EDIT_MAX_BYTES) throw new Error(t('textTooLarge'));
      if (file.path.endsWith('.md')) parseMetadata(splitMarkdown(draft).frontmatter);
      // An explicit human edit/save also accepts that exact prose. Do not keep
      // displaying an older accepted snapshot after the owner has edited it.
      let next = draft;
      if (file.path.endsWith('.md') && needsReview(draft)) next = await new CardRepository(store, vaultId).review({ ...file, revision: draftBase }, draft);
      else await store.saveText(vaultId, file.path, draft, draftBase);
      await store.savePreference(draftKey, null);
      setText(next); setDraft(next); setEditing(false); notice(t('saved'));
    } catch (error) { setError(error instanceof Error ? error.message : t('saveError')); } finally { setBusy(false); }
  };
  const addAnnotation = async () => {
    if (!selection?.anchor) return;
    const saved: ReaderAnnotation = { id: uniqueId(), sourcePath: file.path, documentPath: file.path, extractPath: readingPath,
      kind: isPdf ? 'pdf' : isEpub ? 'epub' : 'markdown', location: selection.location, positionLabel: selection.positionLabel,
      text: selection.text, note, color, anchor: selection.anchor, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const next = { ...currentRecord.current, annotations: [...currentRecord.current.annotations, saved] };
    try { await persistRecord(next, true); await handle.current?.setAnnotations(next.annotations); window.getSelection()?.removeAllRanges(); setSelection(null); setNote(''); notice(t('annotationSaved')); } catch { setError(t('saveError')); }
  };
  const saveExcerpt = async () => {
    if (!selection || excerptLock.current) return;
    excerptLock.current = true; setBusy(true);
    try {
      await new CardRepository(store, vaultId).createExcerpt(file, selection.text, selection.location || readerState.location, selection.positionLabel, note, selection.anchor);
      window.getSelection()?.removeAllRanges(); setSelection(null); setNote(''); notice(t('saved'));
    } catch { setError(t('saveError')); }
    finally { excerptLock.current = false; setBusy(false); }
  };
  let metadata: Record<string, unknown> = {};
  try { metadata = parseMetadata(splitMarkdown(draft).frontmatter); } catch { /* Raw editor can repair invalid frontmatter. */ }
  const statuses = ({ task: TASK_STATUSES, project: PROJECT_STATUSES, goal: GOAL_STATUSES, source: SOURCE_STATUSES, knowledge: KNOWLEDGE_STATUSES } as Record<string, readonly string[]>)[String(metadata.type)] ?? [];
  const changeProperty = (key: string, value: unknown) => { try { setDraft(patchMarkdown(draft, { [key]: value })); } catch (error) { setError(error instanceof Error ? error.message : t('saveError')); } };
  const close = async () => {
    try {
    if (editing && draft !== text) await store.savePreference(draftKey, { text: draft, baseRevision: draftBase });
    if (currentRecord.current.progress || currentRecord.current.annotations.length) await saveRecord(currentRecord.current, true);
    onClose();
    } catch { setError(t('saveError')); }
  };
  let pendingReview = false;
  try { pendingReview = text !== null && needsReview(text); } catch { /* Invalid metadata stays repairable. */ }
  const sourceRef = metadata.source_card as { id: string; path: string } | undefined;
  const source = sourceRef && typeof sourceRef.id === 'string' && typeof sourceRef.path === 'string' ? resolveCard(sourceRef, files) : undefined;
  const settleReview = async (keep: boolean) => {
    if (text === null || busy) return;
    setBusy(true);
    try {
      const repository = new CardRepository(store, vaultId);
      const next = keep ? await repository.keepAccepted(file, text) : await repository.review(file, text);
      setText(next); setDraft(next); setShowChanges(false);
      const latest = store.files(vaultId).find(item => item.path === file.path); if (latest) onOpen(latest);
    } catch { setError(t('saveError')); } finally { setBusy(false); }
  };
  const dialogRef = useModalDialog(close, !embedded);
  return <article ref={dialogRef} onPointerDown={() => { readerTouched.current = true; }} onWheel={() => { readerTouched.current = true; }} onKeyDown={() => { readerTouched.current = true; }} role={embedded ? undefined : "dialog"} aria-modal={embedded ? undefined : true} aria-label={displayTitle(file)} className="document-reader" style={{ '--reader-font-size': `${fontSize}px` } as React.CSSProperties}>
    <header className="reader-header"><button className="icon-button" aria-label={t('back')} onClick={() => void close()}><Icon name="back" /></button><div className="reader-title"><strong>{displayTitle(file)}</strong><small>{/\.(pdf|epub)$/i.test(file.path) ? file.path.split('.').at(-1)?.toUpperCase() : ''}</small></div><div className="reader-actions">{isText && !editing && file.size <= EDIT_MAX_BYTES && <button onClick={() => setEditing(true)}><Icon name="edit" />{t('edit')}</button>}{editing && <button className="primary" disabled={busy} onClick={() => void save()}>{t('save')}</button>}<button className="icon-button" onClick={() => void close()} aria-label={t('close')}><Icon name="close" /></button></div></header>
    {!editing && pendingReview && <div className="card-review-strip"><span>{t('aiReviewHint')}</span>{acceptedText ? <button onClick={() => setShowChanges(value => !value)}>{t(showChanges ? 'hideChanges' : 'reviewChanges')}</button> : <button disabled={busy} onClick={() => void settleReview(false)}>{t('reviewContent')}</button>}</div>}
    {!editing && showChanges && pendingReview && acceptedText && text !== null && <ReviewChanges before={acceptedText} after={text} busy={busy} accept={() => void settleReview(false)} keep={() => void settleReview(true)} />}

    {!editing && source && <button className="source-location" onClick={() => onOpen(source, typeof metadata.source_location === 'string' ? metadata.source_location : undefined)}>{t('sourceLocation')} · {String(metadata.source_label ?? '')}</button>}
    {error && <div className="error-notice">{error}<button onClick={() => setError('')}>{t('retry')}</button></div>}
    {loading ? <p className="empty">{t('processing')}</p> : editing ? <div className="editor"><div className="editor-tabs"><button aria-pressed={!rawMode} onClick={() => setRawMode(false)}>{t('content')}</button><button aria-pressed={rawMode} onClick={() => setRawMode(true)}>{t('rawEditor')}</button><small>{t('saveDraft')}</small></div>{rawMode ? <textarea aria-label={t('rawEditor')} className="source-editor" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} /> : <><div className="property-grid">{typeof metadata.type === 'string' && <><label>{t('title')}<input value={String(metadata.title ?? '')} onChange={event => changeProperty('title', event.target.value)} /></label>{!embedded && statuses.length > 0 && <label>{t('status')}<select value={String(metadata.status ?? statuses[0])} onChange={event => changeProperty('status', event.target.value)}>{[...new Set([String(metadata.status ?? statuses[0]), ...statuses])].map(state => <option key={state} value={state}>{stateLabel(state)}</option>)}</select></label>}{!embedded && metadata.type === 'task' && <><label>{t('priority')}<select value={String(metadata.priority ?? 'P2')} onChange={event => changeProperty('priority', event.target.value)}>{['P0', 'P1', 'P2', 'P3'].map(value => <option key={value}>{value}</option>)}</select></label><label>{t('due')}<input type="date" value={String(metadata.due ?? '')} onChange={event => changeProperty('due', event.target.value || null)} /></label><label>{t('schedule')}<input type="date" value={String(metadata.scheduled_for ?? '')} onChange={event => changeProperty('scheduled_for', event.target.value || null)} /></label></>}</>}</div><label className="body-editor-label">{t('content')}<textarea className="body-editor" value={splitMarkdown(draft).body} onChange={event => { const parts = splitMarkdown(draft); setDraft(parts.frontmatter ? `${parts.prefix}${parts.frontmatter}${parts.suffix}${event.target.value}` : event.target.value); }} /></label></>}</div> : <>
      <div className="reader-toolbar"><button aria-pressed={panel === 'toc'} onClick={() => setPanel(panel === 'toc' ? null : 'toc')}>{t('toc')}</button><button aria-pressed={panel === 'search'} onClick={() => setPanel(panel === 'search' ? null : 'search')}><Icon name="search" />{t('readerSearch')}</button><button aria-pressed={panel === 'notes'} onClick={() => setPanel(panel === 'notes' ? null : 'notes')}>{t('annotations')} · {record.annotations.length}</button>{store.getSnapshot().catalog.capabilities?.includes('vault-library-v1') && <button aria-pressed={panel === 'history'} onClick={() => setPanel(panel === 'history' ? null : 'history')}>{t('versionHistory')}</button>}<span className="toolbar-spacer" /><button aria-label={`${t('fontSize')} −`} onClick={() => { const value = Math.max(13, fontSize - 1); setFontSize(value); void store.savePreference('reader-font', value); }}>A−</button><button aria-label={`${t('fontSize')} +`} onClick={() => { const value = Math.min(28, fontSize + 1); setFontSize(value); void store.savePreference('reader-font', value); }}>A+</button></div>
      <div className="reader-body">{panel && <aside className="reader-panel">{panel === 'history' && <VersionHistory store={store} vaultId={vaultId} file={file} onRestored={() => { const updated = store.files(vaultId).find(item => item.path === file.path); if (updated) onOpen(updated); }} />}{panel === 'toc' && readerState.toc.map(item => <button key={item.id} style={{ paddingInlineStart: `${12 + item.depth * 12}px` }} onClick={() => void handle.current?.goTo(item.target)}>{item.label}</button>)}{panel === 'search' && <><form onSubmit={event => { event.preventDefault(); void handle.current?.search(query).then(setResults); }}><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('readerSearch')} /><button>{t('search')}</button></form>{results.map(result => <button key={result.id} onClick={() => void handle.current?.goTo(result.location)}>{result.excerpt}</button>)}</>}{panel === 'notes' && <>{!record.annotations.length && <EmptyNote />}{record.annotations.map(annotation => <div className="annotation" key={annotation.id}><button onClick={() => void handle.current?.goTo(isText ? `annotation:${annotation.id}` : annotation.location)}><blockquote>{annotation.text}</blockquote><p>{annotation.note}</p></button><button className="icon-button" aria-label={t('removeAnnotation')} onClick={() => { const next = { ...currentRecord.current, annotations: currentRecord.current.annotations.filter(item => item.id !== annotation.id), deleted: { ...currentRecord.current.deleted, [annotation.id]: new Date().toISOString() } }; void persistRecord(next, true).then(() => handle.current?.setAnnotations(next.annotations)).catch(() => setError(t('saveError'))); }}><Icon name="close" /></button></div>)}</>}</aside>}<section ref={hostRef} className={`reader-document ${isText ? 'text-document' : ''}`} /></div>
      {selection && <div className="selection-toolbar"><div className="selection-preview">{selection.text.slice(0, 100)}</div><div className="annotation-input"><input value={note} onChange={event => setNote(event.target.value)} placeholder={t('note')} />{(['yellow', 'red', 'blue', 'green'] as const).map(value => <button key={value} className={`color-choice is-${value}`} aria-label={`${t('highlight')} ${value}`} aria-pressed={color === value} onClick={() => setColor(value)} />)}<button onPointerDown={event => event.preventDefault()} onClick={() => void addAnnotation()}>{note ? t('annotate') : t('highlight')}</button><button onPointerDown={event => event.preventDefault()} disabled={busy} onClick={() => void saveExcerpt()}>{t('saveExcerpt')}</button></div></div>}
      {(isPdf || isEpub) && <footer className="reader-footer"><button disabled={!readerState.canPrevious} onClick={() => void handle.current?.previous()}>{t('previousPage')}</button><span>{readerState.positionLabel}</span><button disabled={!readerState.canNext} onClick={() => void handle.current?.next()}>{t('nextPage')}</button></footer>}
    </>}
  </article>;
}
function EmptyNote() { return <p className="empty">{t('noAnnotations')}</p>; }
