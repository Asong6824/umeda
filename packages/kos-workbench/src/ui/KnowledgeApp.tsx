import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { VaultSummary } from '@cindy/device-link';
import type { LibraryModel } from '../library/model';
import { CardRepository } from '../cards/repository';
import { cardsFromFiles, isWhiteboard, needsReview, resolveCard, type Card } from '../cards/model';
import { displayTitle } from '../documents';
import { beforeLeave } from '../host';
import { t } from '../messages';
import { DocumentReader } from './DocumentReader';
import { Whiteboard } from './Whiteboard';
import { LibraryFiles } from './LibraryFiles';
import { VersionHistory } from './VersionHistory';

type View = 'whiteboards' | 'cardLibrary' | 'journal' | 'tagsView' | 'reviewQueue' | 'files';
export function KnowledgeApp({ store }: { store: LibraryModel }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [vaultId, setVaultId] = useState(''), [view, setView] = useState<View>('whiteboards');
  const [boardReady, setBoardReady] = useState(false);
  const [boardPath, setBoardPath] = useState(''), [selected, setSelected] = useState<VaultSummary | null>(null);
  const [location, setLocation] = useState<string | undefined>(), [focusCard, setFocusCard] = useState<string>();
  const [notice, setNotice] = useState(''), [query, setQuery] = useState(''), [tag, setTag] = useState('');
  const [createBoard, setCreateBoard] = useState(false), [boardTitle, setBoardTitle] = useState(''), [creating, setCreating] = useState(false);
  const [compose, setCompose] = useState(false), [addFile, setAddFile] = useState<VaultSummary | null>(null);
  const [reviewPaths, setReviewPaths] = useState<Set<string>>(new Set()), [reviewLoading, setReviewLoading] = useState(false);
  const [searchPaths, setSearchPaths] = useState<Set<string> | null>(null);
  const files = useMemo(() => store.files(vaultId), [store, vaultId, snapshot]);
  const cards = useMemo(() => cardsFromFiles(files), [files]);
  const boards = useMemo(() => files.filter(file => !file.deleted && isWhiteboard(file)), [files]);
  const activeBoard = boards.find(file => file.path === boardPath);
  const repository = useMemo(() => new CardRepository(store, vaultId), [store, vaultId]);
  const boardLock = useRef(false);
  useEffect(() => {
    void store.initialize().catch(() => setNotice(t('readError')));
    if (window.__UMEDA_BOOT__?.hostLibrary) return;
    const resume = () => { if (document.visibilityState !== 'hidden') void store.refresh().catch(() => setNotice(t('readError'))); };
    document.addEventListener('visibilitychange', resume); window.addEventListener('umeda-resume', resume);
    const timer = setInterval(resume, 60_000);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('umeda-resume', resume); };
  }, [store]);
  useEffect(() => { if (!vaultId && snapshot.catalog.vaults.length) setVaultId(snapshot.catalog.vaults[0].id); }, [snapshot.catalog.vaults, vaultId]);
  useEffect(() => {
    let alive = true; setBoardReady(false); setSelected(null); setBoardPath(''); setAddFile(null); setCompose(false); setFocusCard(undefined);
    if (vaultId) void store.preference(`active-whiteboard:${vaultId}`, '').then(path => { if (alive) { setBoardPath(path); setBoardReady(true); } }).catch(() => { if (alive) { setBoardReady(true); setNotice(t('readError')); } });
    return () => { alive = false; };
  }, [store, vaultId]);
  useEffect(() => { if (boardReady && boardPath) void store.savePreference(`active-whiteboard:${vaultId}`, boardPath).catch(() => setNotice(t('saveError'))); }, [store, vaultId, boardReady, boardPath]);
  useEffect(() => { if (boardReady && !boardPath && boards.length) setBoardPath(boards[0].path); }, [boards, boardPath, boardReady]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  useEffect(() => {
    setSearchPaths(null); if (!query.trim()) return;
    let alive = true;
    const timer = setTimeout(() => { void store.search(vaultId, query.slice(0, 200)).then(result => { if (alive) setSearchPaths(new Set(result.hits.map(hit => hit.file.path))); }).catch(() => { if (alive) setNotice(t('readError')); }); }, 250);
    return () => { alive = false; clearTimeout(timer); };
  }, [store, vaultId, query]);
  // Only inspect AI content when the owner opens the review view, never inject it into an Agent.
  useEffect(() => {
    if (view !== 'reviewQueue') { setReviewLoading(false); return; }
    let alive = true; setReviewLoading(true);
    void (async () => {
      const pending = new Set<string>();
      for (const card of cards.filter(card => card.ai)) {
        if (!alive) return;
        try { if (needsReview(await store.readText(vaultId, card.file))) pending.add(card.file.path); }
        catch { if (alive) setNotice(t('readError')); }
      }
      if (alive) { setReviewPaths(pending); setReviewLoading(false); }
    })();
    return () => { alive = false; };
  }, [view, cards, store, vaultId]);
  const open = (file: VaultSummary, target?: string) => { setLocation(target); setSelected(file); };
  const visibleCards = cards.filter(card => (!tag || card.tags.includes(tag)) && (!query || `${card.title} ${card.tags.join(' ')} ${card.file.excerpt}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()) || searchPaths?.has(card.file.path)) && (view !== 'reviewQueue' || reviewPaths.has(card.file.path)));
  const tags = [...new Set(cards.flatMap(card => card.tags))].sort();
  const saveNewBoard = async (event: FormEvent) => {
    event.preventDefault(); if (!boardTitle.trim() || boardLock.current) return;
    boardLock.current = true; setCreating(true);
    try { const file = await repository.createBoard(boardTitle.trim()); setBoardPath(file.path); setCreateBoard(false); setBoardTitle(''); setView('whiteboards'); }
    catch { setNotice(t('saveError')); } finally { boardLock.current = false; setCreating(false); }
  };
  return <div className="knowledge-shell">
    <aside className="knowledge-sidebar"><header><strong>KOS</strong>{snapshot.catalog.vaults.length > 1 && <select aria-label={t('files')} value={vaultId} onChange={event => setVaultId(event.target.value)}>{snapshot.catalog.vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.name}</option>)}</select>}</header>
      <nav>{(['journal', 'whiteboards', 'cardLibrary', 'tagsView', 'reviewQueue', 'files'] as const).map(id => <button key={id} aria-current={view === id ? 'page' : undefined} onClick={() => { setView(id); setTag(''); setQuery(''); }}>{t(id)}</button>)}</nav>
      <div className="whiteboard-directory"><header><span>{t('whiteboards')}</span><button aria-label={t('newBoard')} onClick={() => setCreateBoard(true)}>＋</button></header>
        {createBoard && <form onSubmit={event => void saveNewBoard(event)}><input autoFocus aria-label={t('boardTitle')} placeholder={t('boardTitle')} value={boardTitle} maxLength={160} onChange={event => setBoardTitle(event.target.value)} /><button disabled={creating || !boardTitle.trim()}>{t('save')}</button><button type="button" disabled={creating} onClick={() => setCreateBoard(false)}>{t('close')}</button></form>}
        {boards.map(file => <button key={file.path} aria-current={view === 'whiteboards' && file.path === boardPath ? 'page' : undefined} onClick={() => { setBoardPath(file.path); setView('whiteboards'); setFocusCard(undefined); }}>{displayTitle(file)}</button>)}
      </div>
      <footer><span role="status">{snapshot.loading ? t('processing') : snapshot.offline ? t('offline') : snapshot.pending.length ? `${snapshot.pending.length} ${t('pending')}` : t('synced')}</span><button onClick={() => void store.refresh().catch(() => setNotice(t('readError')))}>{t('refresh')}</button></footer>
    </aside>
    <main className="knowledge-main">
      {snapshot.error && <div className="error-notice" role="alert">{snapshot.error}</div>}
      {!snapshot.loading && !snapshot.catalog.vaults.length ? <div className="empty"><h1>{t('noVault')}</h1><p>{t('noVaultHint')}</p></div> : <>
      {view === 'whiteboards' ? <div className="whiteboard-workspace">
        {activeBoard ? <Whiteboard key={`${vaultId}:${activeBoard.path}`} store={store} vaultId={vaultId} file={activeBoard} files={files} addFile={addFile} added={() => setAddFile(null)} open={open} notice={setNotice} focusCard={focusCard} /> : <div className="empty"><h1>{t('selectBoard')}</h1><button onClick={() => setCreateBoard(true)}>{t('newBoard')}</button></div>}
        <aside className="card-shelf"><header><strong>{t('cardLibrary')}</strong><button onClick={() => setCompose(true)}>{t('newCard')}</button></header><input aria-label={t('searchCards')} placeholder={t('searchCards')} value={query} onChange={event => setQuery(event.target.value)} /><CardList cards={visibleCards} open={open} add={activeBoard ? file => setAddFile(file) : undefined} /></aside>
      </div> : view === 'files' ? <LibraryFiles store={store} vaultId={vaultId} files={files} onOpen={open} onCreate={() => setCompose(true)} /> : <section className="knowledge-library"><header><div><h1>{t(view)}</h1>{view === 'journal' && <p className="muted">{t('journalHint')}</p>}</div><button onClick={() => setCompose(true)}>{t('newCard')}</button></header>
        {(compose || view === 'journal') && <QuickNote key={vaultId} store={store} vaultId={vaultId} saved={file => { setCompose(false); open(file); }} notice={setNotice} />}
        <input aria-label={t('searchCards')} placeholder={t('searchCards')} value={query} onChange={event => setQuery(event.target.value)} />
        {view === 'tagsView' && <div className="knowledge-tags"><button aria-pressed={!tag} onClick={() => setTag('')}>{t('all')}</button>{tags.map(value => <button key={value} aria-pressed={tag === value} onClick={() => setTag(value)}>{value}</button>)}</div>}
        {view === 'reviewQueue' && reviewLoading ? <p className="empty">{t('processing')}</p> : !visibleCards.length ? <p className="empty">{t(view === 'reviewQueue' ? 'reviewEmpty' : 'empty')}</p> : <CardList cards={view === 'journal' ? visibleCards.filter(card => card.kind === 'note').sort((a, b) => b.file.modifiedAt - a.file.modifiedAt) : visibleCards} open={open} />}
      </section>}
      {compose && (view === 'whiteboards' || view === 'files') && <section className="floating-capture"><header><strong>{t('newCard')}</strong><button onClick={() => setCompose(false)}>{t('close')}</button></header><QuickNote key={vaultId} store={store} vaultId={vaultId} saved={file => { setCompose(false); if (activeBoard) setAddFile(file); }} notice={setNotice} /></section>}
      </>}
    </main>
    {selected && <aside className="knowledge-reader">{selected.deleted ? <div className="trash-history"><header><h2>{displayTitle(selected)}</h2><button onClick={() => setSelected(null)}>{t('close')}</button></header><VersionHistory store={store} vaultId={vaultId} file={selected} onRestored={() => setSelected(null)} /></div> : <DocumentReader key={`${vaultId}:${selected.path}:${selected.revision}:${location ?? ''}`} embedded store={store} vaultId={vaultId} file={selected} files={files} startEditing={false} initialLocation={location} onClose={() => setSelected(null)} onOpen={open} notice={setNotice} />}
      {!selected.deleted && <CardLocations repository={repository} boards={boards} selected={selected} files={files} choose={(board, id) => { setSelected(null); setBoardPath(board.path); setFocusCard(id); setView('whiteboards'); }} />}
    </aside>}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}
function CardList({ cards, open, add }: { cards: Card[]; open(file: VaultSummary): void; add?(file: VaultSummary): void }) {
  const [limit, setLimit] = useState(40);
  useEffect(() => setLimit(40), [cards.length]);
  return <div className="knowledge-card-list">{cards.slice(0, limit).map(card => <article key={card.file.path} draggable onDragStart={event => { event.dataTransfer.setData('application/x-kos-card', card.file.path); event.dataTransfer.effectAllowed = 'copy'; }}>
    <button className="knowledge-card-open" onClick={() => open(card.file)}><small>{t(card.kind === 'note' ? 'noteCard' : card.kind === 'excerpt' ? 'excerptCard' : 'materialCard')}</small><strong>{card.title}</strong><p>{card.file.excerpt.slice(0, 160)}</p></button>
    {card.tags.length > 0 && <small>{card.tags.join(' · ')}</small>}{add && <button onClick={() => add(card.file)}>{t('addToBoard')}</button>}
  </article>)}{limit < cards.length && <button onClick={() => setLimit(value => value + 40)}>{t('loadMore')}</button>}</div>;
}
function QuickNote({ store, vaultId, saved, notice }: { store: LibraryModel; vaultId: string; saved(file: VaultSummary): void; notice(message: string): void }) {
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const current = useRef({ title, body }), lock = useRef(false), restored = useRef(false), chain = useRef(Promise.resolve()); current.current = { title, body };
  const key = `card-composer:${vaultId}`;
  const persist = () => { if (!restored.current) return Promise.resolve(); const value = { ...current.current }; const next = chain.current.catch(() => {}).then(() => store.savePreference(key, value)); chain.current = next; return next; };
  useEffect(() => { let alive = true; void store.preference(key, { title: '', body: '' }).then(value => { if (alive) { setTitle(value.title); setBody(value.body); restored.current = true; setReady(true); } }).catch(() => notice(t('readError'))); return () => { alive = false; if (current.current.title || current.current.body) void persist().catch(() => notice(t('saveError'))); }; }, [store, key]);
  useEffect(() => beforeLeave(persist), [store, key]);
  useEffect(() => { if (!ready) return; const timer = setTimeout(() => void persist().catch(() => notice(t('saveError'))), 300); return () => clearTimeout(timer); }, [title, body, ready]);
  return <form className="quick-note" onSubmit={event => {
    event.preventDefault(); if (lock.current || !ready || !title.trim()) return; lock.current = true; setBusy(true);
    void (async () => { try { await persist(); const file = await new CardRepository(store, vaultId).createNote(title.trim(), body); current.current = { title: '', body: '' }; setTitle(''); setBody(''); await persist(); notice(t('saved')); saved(file); } catch { notice(t('saveError')); } finally { lock.current = false; setBusy(false); } })();
  }}><input aria-label={t('title')} placeholder={t('title')} value={title} maxLength={160} disabled={!ready || busy} onChange={event => setTitle(event.target.value)} /><textarea aria-label={t('content')} placeholder={t('captureHint')} value={body} disabled={!ready || busy} rows={5} onChange={event => setBody(event.target.value)} /><button className="primary" disabled={!ready || busy || !title.trim()}>{t('save')}</button></form>;
}
function CardLocations({ repository, boards, selected, files, choose }: { repository: CardRepository; boards: VaultSummary[]; selected: VaultSummary; files: VaultSummary[]; choose(board: VaultSummary, id: string): void }) {
  const [locations, setLocations] = useState<Array<{ board: VaultSummary; id: string }>>([]), [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true; setLocations([]); setFailed(false);
    void (async () => { const result: typeof locations = []; for (const board of boards) { if (!alive) return; try { const value = await repository.readBoard(board); const item = value.items.find(item => item.card && resolveCard(item.card, files)?.path === selected.path); if (item?.card) result.push({ board, id: item.card.id }); } catch { if (alive) setFailed(true); } } if (alive) setLocations(result); })();
    return () => { alive = false; };
  }, [repository, boards, selected.path]);
  return <details className="card-locations"><summary>{t('cardLocations')}</summary>{failed && <p>{t('readError')}</p>}{!locations.length && !failed && <p>{t('noBoardLocations')}</p>}{locations.map(value => <button key={value.board.path} onClick={() => choose(value.board, value.id)}>{displayTitle(value.board)}</button>)}</details>;
}
