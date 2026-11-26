import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { VaultSummary } from '@cindy/device-link';
import type { LibraryModel, SearchResults } from '../library/model';
import { displayTitle } from '../documents';
import { t } from '../messages';
import { Icon } from './Icons';
import { MoveDocument, LibrarySpace } from './LibraryTools';
import { indexBook } from '../reader/indexing';

export function LibraryFiles({ store, vaultId, files, onOpen, onCreate }: {
  store: LibraryModel; vaultId: string; files: VaultSummary[]; onOpen(file: VaultSummary, location?: string): void; onCreate(): void;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [page, setPage] = useState(1);
  const [reply, setReply] = useState<(SearchResults & { query: string }) | null>(null), [error, setError] = useState(''), [searching, setSearching] = useState(false);
  const result = reply?.query === query ? reply : null;
  const [busy, setBusy] = useState(false);
  const [moving, setMoving] = useState<VaultSummary | null>(null), [space, setSpace] = useState(false);
  const indexing = useRef<AbortController | null>(null), mounted = useRef(true);
  const [bookJob, setBookJob] = useState<{ path: string; count: number } | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; indexing.current?.abort(); }; }, []);
  const extract = async (file: VaultSummary) => {
    if (indexing.current) return;
    const controller = new AbortController(); indexing.current = controller;
    setBookJob({ path: file.path, count: 0 }); setError('');
    try { await indexBook(store, vaultId, file, controller.signal, count => { if (mounted.current) setBookJob({ path: file.path, count }); }); }
    catch { if (mounted.current && !controller.signal.aborted) setError(t('indexBookError')); }
    finally { indexing.current = null; if (mounted.current) setBookJob(null); }
  };
  useEffect(() => {
    let alive = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void store.search(vaultId, query).then(value => { if (alive) { setReply({ ...value, query }); setError(''); } }, () => { if (alive) setError(t('readError')); }).finally(() => { if (alive) setSearching(false); });
    }, query ? 180 : 0);
    return () => { alive = false; clearTimeout(timer); };
  }, [store, vaultId, query, snapshot.catalog, snapshot.pending, snapshot.downloads, snapshot.moves, snapshot.bookIndexes]);
  const snippets = useMemo(() => new Map(result?.hits.map(hit => [hit.file.path, hit.snippet]) ?? []), [result]);
  const source = filter === 'deleted' ? (snapshot.catalog.trash?.[vaultId] ?? []) : files;
  const filtered = useMemo(() => source.filter(file => !file.path.startsWith('90_系统/umeda/')
    && (filter === 'all' || filter === 'deleted' || file.path.toLowerCase().endsWith(`.${filter}`))
    && (!query.trim() || (filter === 'deleted' ? `${file.path} ${file.excerpt}`.toLowerCase().includes(query.trim().toLowerCase()) : snippets.has(file.path)))), [source, filter, query, snippets]);
  const pages = Math.max(1, Math.ceil(filtered.length / 60)), current = Math.min(page, pages);
  const jobs = (snapshot.downloads ?? []).filter(job => job.vaultId === vaultId);
  const ready = jobs.filter(job => job.status === 'ready' && files.some(file => file.hash === job.hash && (job.documentId ? file.documentId === job.documentId : file.path === job.path))).length;
  const act = async (run: () => Promise<void>) => { setBusy(true); try { await run(); if (mounted.current) setError(''); } catch (error) { if (mounted.current) setError(error instanceof Error && error.message === 'LIBRARY_OFFLINE_SIZE_LIMIT' ? t('textTooLarge') : t('saveError')); } finally { if (mounted.current) setBusy(false); } };
  return <main className="file-browser">
    <div className="file-toolbar"><label className="search-field"><Icon name="search" /><input aria-label={t('fullTextSearch')} maxLength={200} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} placeholder={t('fullTextSearch')} /></label>
      <select aria-label={t('type')} value={filter} onChange={event => { setFilter(event.target.value); setPage(1); }}>{['all', 'md', 'pdf', 'epub', ...(snapshot.catalog.capabilities?.includes('vault-library-v1') ? ['deleted'] : [])].map(kind => <option key={kind} value={kind}>{kind === 'all' ? t('all') : kind === 'deleted' ? t('trash') : kind.toUpperCase()}</option>)}</select>
      <button onClick={onCreate}><Icon name="plus" />{t('create')}</button><button onClick={() => setSpace(true)}>{t('storageSpace')}</button></div>
    <div className="library-offline-toolbar"><p role="status">{result ? `${t('searchCoverage')} ${result.covered} / ${result.total}` : t('processing')} · {t('offlineReady')} {ready} / {jobs.length}<small>{t('searchCoverageHint')}</small></p>
      <button disabled={busy || !vaultId} onClick={() => void act(() => store.pinOffline(vaultId))}>{t('downloadDocuments')}</button></div>
    {error && <p className="error-notice" role="alert">{error}</p>}
    {bookJob && <div className="library-operation"><p role="status">{t('indexingBook')} · {bookJob.count}<small>{bookJob.path}</small></p><button onClick={() => indexing.current?.abort()}>{t('stopIndexing')}</button></div>}
    {(snapshot.moves ?? []).filter(move => move.vaultId === vaultId).map(move => <div className="library-operation" key={move.id}>
      <p role="status">{move.status === 'conflict' ? t('moveConflict') : t('movePending')}<small>{move.from} → {move.to}</small></p>
      {move.status === 'conflict' && <button disabled={busy} onClick={() => void act(() => store.retryMove(vaultId, move.id))}>{t('retryMove')}</button>}
      <button disabled={busy} onClick={() => void act(() => store.cancelMove(vaultId, move.id))}>{t('cancelMove')}</button>
    </div>)}
    <div className="file-count" role="status">{searching && query ? t('processing') : `${filtered.length} ${t('fileCount')}`}{result?.more && query ? ` · ${t('narrowSearch')}` : ''}</div>
    {filtered.slice((current - 1) * 60, current * 60).map(file => {
      const job = jobs.find(item => file.documentId ? item.documentId === file.documentId : item.path === file.path);
      const status = job?.status === 'ready' && job.hash !== file.hash ? 'pending' : job?.status;
      const book = snapshot.bookIndexes?.[`${vaultId}:${file.hash}`], match = result?.hits.find(hit => hit.file.path === file.path);
      return <div className="object-row library-file" key={file.path}>
        <button className="document-row row-main" onClick={() => onOpen(file, query ? match?.location : undefined)}><Icon name={/\.(pdf|epub)$/i.test(file.path) ? 'book' : 'note'} /><span className="row-main"><strong>{displayTitle(file)}</strong><small>{file.path}</small>{query && snippets.get(file.path) && <span className="search-snippet">{match?.label ? `${t('bookSection')} ${match.label} · ` : ''}{snippets.get(file.path)}</span>}</span></button>
        {!file.deleted && <div className="offline-actions">{job && <small role="status">{status === 'ready' ? t('availableOffline') : status === 'error' ? t('downloadPaused') : t('downloadPending')}</small>}
          {/\.(pdf|epub)$/i.test(file.path) && (book?.complete ? <small>{book.bytes ? t('bookIndexed') : t('bookNoText')}</small> : <button disabled={!!bookJob || file.size > 32 * 1024 * 1024} onClick={() => void extract(file)}>{book?.count ? t('resumeIndexing') : t('indexBook')}</button>)}
          <button disabled={busy} onClick={() => void act(() => job && status !== 'error' ? store.cancelOffline(vaultId, job.path) : store.pinOffline(vaultId, file.path))}>{job && status !== 'error' ? t('unpinOffline') : status === 'error' ? t('retry') : t('keepOffline')}</button>
          {file.revision > 0 && snapshot.catalog.capabilities?.includes('vault-library-v1') && <button disabled={busy} onClick={() => setMoving(file)}>{t('moveDocument')}</button>}</div>}
      </div>;
    })}
    {!filtered.length && !searching && <p className="empty">{t('empty')}</p>}
    {pages > 1 && <div className="pagination"><button aria-label={t('previousPage')} disabled={current <= 1} onClick={() => setPage(current - 1)}>←</button><span>{current} / {pages}</span><button aria-label={t('nextPage')} disabled={current >= pages} onClick={() => setPage(current + 1)}>→</button></div>}
    {moving && <MoveDocument store={store} vaultId={vaultId} file={moving} onClose={() => setMoving(null)} />}
    {space && <LibrarySpace store={store} onClose={() => setSpace(false)} />}
  </main>;
}
