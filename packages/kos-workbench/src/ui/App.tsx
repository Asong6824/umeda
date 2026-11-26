import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { parseVaultChange, type VaultSummary } from '@cindy/device-link';
import { attentionSummary, currentActionTasks, goalProgress, halfYearPeriod, knowledgeRows, pendingReviewRows, projectRows, sourceRows, todayScheduleEntries, sortTasks } from '../core/dashboard';
import { activityHeatmap, knowledgeAssetTotal, pipelineFunnel } from '../core/metrics';
import { addDays, dateRange } from '../core/snapshot';
import { type DashboardCardId, type BentoLayoutItem } from '../core/bento-layout';
import type { KosObject, TaskObject } from '../core/model';
import { displayTitle, indexedObjects, localDay, patchMarkdown } from '../documents';
import type { LibraryModel as WorkbenchStore } from '../library/model';
import { uniqueId, beforeLeave } from '../host';
import { t, stateLabel } from '../messages';
import { Bento } from './Bento';
import { Icon } from './Icons';
import { useModalDialog } from './useModalDialog';
import { DocumentReader } from './DocumentReader';
import { VersionHistory } from './VersionHistory';
import { LibraryFiles } from './LibraryFiles';
import { WORKBENCH_LAYOUT, MOBILE_CARD_ORDER } from './layout';

function SectionTitle({ title, value, children }: { title: string; value?: ReactNode; children?: ReactNode }) {
  return <header className="section-title"><h2>{title}</h2>{value !== undefined && <span className="section-value">{value}</span>}<div className="section-actions">{children}</div></header>;
}
function Empty({ text }: { text?: string }) { return <p className="empty">{text ?? t('empty')}</p>; }
function PagedList<T>({ items, render, size = 5 }: { items: T[]; render(item: T): ReactNode; size?: number }) {
  const [page, setPage] = useState(1), pages = Math.max(1, Math.ceil(items.length / size)), current = Math.min(page, pages);
  return <>{items.slice((current - 1) * size, current * size).map(render)}{pages > 1 && <div className="pagination"><button aria-label={t('previousPage')} disabled={current <= 1} onClick={() => setPage(current - 1)}>←</button><span>{current} / {pages} · {items.length}</span><button aria-label={t('nextPage')} disabled={current >= pages} onClick={() => setPage(current + 1)}>→</button></div>}</>;
}
function Metric({ value, label, attention = false }: { value: ReactNode; label: string; attention?: boolean }) {
  return <div className={`metric${attention ? ' attention' : ''}`}><strong>{value}</strong><span>{label}</span></div>;
}
export function App({ store }: { store: WorkbenchStore }) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [vaultId, setVaultId] = useState(''), [view, setView] = useState<'board' | 'files'>('board');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<VaultSummary | null>(null), [editing, setEditing] = useState(false);
  const [searchLocation, setSearchLocation] = useState<string | undefined>();
  const [deletedSelection, setDeletedSelection] = useState<VaultSummary | null>(null);
  const [composer, setComposer] = useState<'capture' | 'task' | 'project' | 'goal' | 'knowledge' | 'source' | null>(null);
  const [mobileOrder, setMobileOrder] = useState<DashboardCardId[]>([...MOBILE_CARD_ORDER]);
  const [layout, setLayout] = useState<BentoLayoutItem[] | null>(null), [now, setNow] = useState(new Date());
  const files = useMemo(() => store.files(vaultId), [store, vaultId, snapshot]);
  const { objects, issues } = useMemo(() => indexedObjects(files), [files]);
  const today = localDay(now), attention = attentionSummary(objects, today, {}), assets = knowledgeAssetTotal(objects);
  const tasks = currentActionTasks(objects, today), projects = projectRows(objects, today, {}), sources = sourceRows(objects), pending = pendingReviewRows(objects);
  const actionTasks = sortTasks(objects.filter((object): object is TaskObject => object.type === 'task' && !['done', 'cancelled'].includes(object.status)), today);
  useEffect(() => {
    void store.initialize().catch(error => setNotice(error instanceof Error ? error.message : t('readError')));
    const timer = setInterval(() => { setNow(new Date()); if (!window.__UMEDA_BOOT__?.hostLibrary && document.visibilityState !== 'hidden') void store.refresh(); }, 60_000);
    const refresh = () => { if (!window.__UMEDA_BOOT__?.hostLibrary && document.visibilityState !== 'hidden') void store.refresh(); };
    document.addEventListener('visibilitychange', refresh); window.addEventListener('umeda-resume', refresh);
    const saveError = () => setNotice(t('saveError')); window.addEventListener('umeda-save-error', saveError);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('umeda-resume', refresh); window.removeEventListener('umeda-save-error', saveError); };
  }, [store]);
  useEffect(() => {
    if (window.__UMEDA_BOOT__?.hostLibrary) return;
    let stop = () => {};
    const start = () => { stop(); if (vaultId && document.visibilityState !== 'hidden' && window.__UMEDA_BOOT__?.platform !== 'mobile') stop = store.watch(vaultId); };
    const pause = () => stop(), changed = (event: Event) => {
      const change = parseVaultChange((event as CustomEvent).detail);
      const cursors = store.getSnapshot().catalog.cursors, known = Object.hasOwn(cursors, vaultId) ? cursors[vaultId] : 0;
      if (!change || (change.vaultId === vaultId && change.revision > known)) void store.refresh(true);
    };
    start(); document.addEventListener('visibilitychange', start); window.addEventListener('umeda-resume', start);
    window.addEventListener('umeda-pause', pause); window.addEventListener('umeda-vault-change', changed);
    return () => { stop(); document.removeEventListener('visibilitychange', start); window.removeEventListener('umeda-resume', start); window.removeEventListener('umeda-pause', pause); window.removeEventListener('umeda-vault-change', changed); };
  }, [store, vaultId]);
  useEffect(() => { if (!vaultId && snapshot.catalog.vaults.length) setVaultId(snapshot.catalog.vaults[0].id); }, [snapshot.catalog.vaults, vaultId]);
  useEffect(() => {
    let current = true;
    setLayout(null); setMobileOrder([...MOBILE_CARD_ORDER]); setSelected(null); setDeletedSelection(null); setComposer(null);
    void Promise.all([
      store.preference<DashboardCardId[]>('mobile-order:' + vaultId, MOBILE_CARD_ORDER),
      store.preference<BentoLayoutItem[] | null>(`layout:${vaultId}:${window.__UMEDA_BOOT__?.platform ?? 'desktop'}`, null),
    ]).then(([order, savedLayout]) => { if (current) { setMobileOrder(order); setLayout(savedLayout ?? WORKBENCH_LAYOUT); } })
      .catch(() => { if (current) { setLayout(WORKBENCH_LAYOUT); setNotice(t('readError')); } });
    return () => { current = false; };
  }, [store, vaultId]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  const findFile = (path: string) => files.find(file => file.path === path);
  const open = (file?: VaultSummary, location?: string) => { if (file) { setSearchLocation(location); setSelected(file); setEditing(false); } };
  const openObject = (object: KosObject) => open(findFile(object.filePath));
  const perform = async (object: KosObject, patch: Record<string, unknown>) => {
    const file = findFile(object.filePath); if (!file) return;
    try {
      const text = await store.readText(vaultId, file);
      await store.saveText(vaultId, file.path, patchMarkdown(text, patch), file.revision); setNotice(t('saved'));
    } catch (error) { setNotice(error instanceof Error ? error.message : t('saveError')); }
  };
  const review = (object: KosObject) => {
    if (object.type === 'extract') void perform(object, { review_status: 'reviewed' });
    else if (object.type === 'summary') void perform(object, { reviewed: true });
    else openObject(object);
  };
  const taskRow = (task: TaskObject) => <div className="object-row" key={task.filePath}>
    <button className="check-control" aria-label={`${t('done')} ${task.title ?? task.filePath}`} onClick={() => void perform(task, { status: 'done', completed: today })}><Icon name="check" /></button>
    <button className="row-main" onClick={() => openObject(task)}><strong>{task.title ?? task.filePath.split('/').at(-1)?.replace(/\.md$/, '')}</strong><span>{task.priority} {task.due && <span className={task.due < today ? 'warning-text' : ''}>{task.due}</span>}</span></button>
    <span className="tag">{stateLabel(task.status)}</span>
    <button className="icon-button" title={t('schedule')} aria-label={t('schedule')} onClick={() => void perform(task, { scheduled_for: today })}><Icon name="clock" /></button>
  </div>;
  const objectRow = (file: VaultSummary) => <button key={file.path} className="object-row document-row" onClick={() => file.deleted ? setDeletedSelection(file) : open(file)}>
    <Icon name={/\.(pdf|epub)$/i.test(file.path) ? 'book' : 'note'} /><span className="row-main"><strong>{displayTitle(file)}</strong><small>{file.path}</small></span>
  </button>;
  const reviewFiles = files.filter(file => objects.some(object => object.filePath === file.path && ['diary', 'reflection', 'personal_operating_profile'].includes(object.type)));
  const render = (id: DashboardCardId): ReactNode => {
    if (id === 'schedule') {
      const schedule = todayScheduleEntries(objects, today);
      return <><SectionTitle title={today} /><div className="clock-face">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div><div className="time-track">{Array.from({ length: 48 }, (_, i) => <i key={i} className={i <= now.getHours() * 2 + Math.floor(now.getMinutes() / 30) ? 'elapsed' : ''} />)}</div>{schedule.length ? <PagedList items={schedule} size={4} render={item => <button key={`${item.task.filePath}:${item.times.join(",")}`} className="schedule-row" onClick={() => openObject(item.task)}><span>{item.times.join(" · ")}</span><span>{item.task.title}</span></button>} /> : <Empty text={t('noSchedule')} />}</>;
    }
    if (id === 'goals') {
      const goals = objects.filter((object): object is Extract<KosObject, { type: 'goal' }> => object.type === 'goal' && object.period === halfYearPeriod(today));
      return <><SectionTitle title={t('goals')} value={halfYearPeriod(today)}><button className="icon-button" aria-label={t('create')} onClick={() => setComposer('goal')}><Icon name="plus" /></button></SectionTitle>{!goals.length && <Empty text={t('noGoals')} />}{goals.map(goal => { const progress = goalProgress(objects, goal); return <button className="goal-row" key={goal.filePath} onClick={() => openObject(goal)}><strong>{goal.title}</strong><span>{progress.ratio === null ? t('unknownProgress') : `${Math.round(progress.ratio * 100)}%`}</span><progress value={progress.ratio ?? 0} max="1" /></button>; })}</>;
    }
    if (id === 'progress') {
      const month = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const start = new Date(now.getFullYear(), 0, 1), end = new Date(now.getFullYear() + 1, 0, 1);
      const values = [(now.getTime() - start.getTime()) / (end.getTime() - start.getTime()), (now.getDate() - 1 + now.getHours() / 24) / month, ((now.getDay() + 6) % 7 + now.getHours() / 24) / 7, (now.getHours() + now.getMinutes() / 60) / 24];
      return <><SectionTitle title={t('progress')} value={now.getFullYear()} />{(['year', 'month', 'week', 'day'] as const).map((label, index) => <div className="progress-row" key={label}><span>{t(label)}</span><progress max="1" value={values[index]} /><small>{Math.floor(values[index] * 100)}%</small></div>)}</>;
    }
    if (id === 'heatmap') {
      const heat = activityHeatmap(objects), days = dateRange(addDays(today, -363), today);
      return <><SectionTitle title={t('heatmap')} value={days.reduce((total, day) => total + (heat[day] ?? 0), 0)} /><div className="heatmap">{days.map(day => <i key={day} title={`${day}: ${heat[day] ?? 0}`} data-level={Math.min(4, Math.ceil((heat[day] ?? 0) / 2))} />)}</div></>;
    }
    if (id === 'today') return <><SectionTitle title={t('today')} value={today} /><div className="attention-row"><Metric value={attention.overdue} label={t('overdue')} attention={attention.overdue > 0} /><Metric value={attention.blocked} label={t('blocked')} /><Metric value={attention.staleProjects} label={t('stale')} /><Metric value={attention.pendingReview} label={t('pendingReview')} /></div><h3>{t('currentActions')}</h3>{tasks.length ? <PagedList items={tasks} render={taskRow} size={6} /> : <Empty />}</>;
    if (id === 'action') return <><SectionTitle title={t('action')} value={projects.length}><button onClick={() => setComposer('project')}>{t('create')}{t('project')}</button><button onClick={() => setComposer('task')}>{t('create')}{t('task')}</button></SectionTitle><PagedList items={projects} size={4} render={row => <button className="project-row" key={row.object.filePath} onClick={() => openObject(row.object)}><strong>{row.object.title}</strong><span>{row.done} / {row.total}</span><progress value={row.ratio ?? 0} max="1" /></button>} /><h3>{t('task')}</h3><PagedList items={actionTasks} render={taskRow} />{!projects.length && !actionTasks.length && <Empty />}</>;
    if (id === 'input') {
      const pipeline = pipelineFunnel(objects), inboxFiles = files.filter(file => file.path.startsWith('10_收件箱/') && file.path.endsWith('.md'));
      return <><SectionTitle title={t('input')} value={sources.length}><button onClick={() => setComposer('capture')}>{t('capture')}</button></SectionTitle><div className="pipeline">{(['captured', 'extracted', 'summarized', 'reviewed', 'linked'] as const).map(stage => <div key={stage}><strong>{pipeline.stages[stage]}</strong><span>{t(stage)}</span></div>)}</div><h3>{t('inputQueue')}</h3><PagedList items={sources} render={source => objectRow(findFile(source.filePath)!)} /><h3>{t('inbox')} · {inboxFiles.length}</h3><PagedList items={inboxFiles} render={objectRow} size={4} />{!sources.length && !inboxFiles.length && <Empty />}</>;
    }
    if (id === 'knowledge') return <><SectionTitle title={t('knowledge')} value={assets.total}><button onClick={() => setComposer('knowledge')}>{t('create')}</button></SectionTitle><div className="attention-row"><Metric value={assets.knowledge} label={t('knowledge')} /><Metric value={assets.method} label={t('method')} /><Metric value={assets.research} label={t('research')} /></div><PagedList items={knowledgeRows(objects)} render={row => objectRow(findFile(row.object.filePath)!)} size={7} />{!assets.total && <Empty />}</>;
    if (id === 'review') return <><SectionTitle title={t('review')} value={pending.length} /><h3>{t('pendingReview')}</h3><PagedList items={pending} size={5} render={object => <div key={object.filePath} className="review-row"><button className="row-main" onClick={() => openObject(object)}><strong>{displayTitle(findFile(object.filePath)!)}</strong><small>{stateLabel(object.type)}</small></button><button onClick={() => review(object)}>{t(['extract', 'summary'].includes(object.type) ? 'approve' : 'open')}</button></div>} />{!pending.length && <Empty text={t('noReview')} />}<h3>{t('recentReview')}</h3><PagedList items={reviewFiles.sort((a, b) => b.modifiedAt - a.modifiedAt)} size={4} render={objectRow} /></>;
    return <><SectionTitle title={t('system')} /><h3>{t('syncState')}</h3><div className="system-line"><span>{snapshot.offline ? t('offline') : t('synced')}</span><span>{files.length} {t('fileCount')}</span></div><p className="muted">{t('cachedHint')}</p><h3>{t('health')}</h3>{issues.length ? <PagedList items={issues} size={5} render={issue => <button className="finding" key={issue.path} onClick={() => open(findFile(issue.path))}><strong>{issue.path}</strong><span>{issue.message}</span></button>} /> : <p>{t('healthy')}</p>}<h3>{t('recovery')}</h3><p>{snapshot.pending.length ? `${snapshot.pending.length} ${t('pending')}` : t('noPending')}</p>{snapshot.conflicts.map(path => <button key={path} className="finding" onClick={() => open(findFile(path))}>{path}</button>)}</>;
  };
  return <div className="workbench-shell">
    <header className="workbench-header"><div className="brand"><span className="brand-mark">K</span><div><strong>KOS</strong><small>{t('workbench')}</small></div></div><nav><button aria-current={view === 'board' ? 'page' : undefined} onClick={() => setView('board')}>{t('workbench')}</button><button aria-current={view === 'files' ? 'page' : undefined} onClick={() => setView('files')}>{t('files')}</button></nav><div className="header-actions">{snapshot.catalog.vaults.length > 1 && <select aria-label={t('files')} value={vaultId} onChange={event => setVaultId(event.target.value)}>{snapshot.catalog.vaults.map(vault => <option key={vault.id} value={vault.id}>{vault.name}</option>)}</select>}<button onClick={() => setComposer('capture')}><Icon name="plus" /><span>{t('capture')}</span></button><button className="icon-button" onClick={() => void store.refresh()} aria-label={t('refresh')}><Icon name="refresh" /></button></div></header>
    <div className="sync-strip" role="status"><span className={`connection-dot ${snapshot.offline ? 'offline' : ''}`} />{snapshot.loading ? `${t('loading')} · ${snapshot.progress}` : snapshot.offline ? t('offline') : t('synced')}{snapshot.pending.length > 0 && <span> · {snapshot.pending.length} {t('pending')}</span>}</div>
    {snapshot.error && <div className="error-notice">{snapshot.error}<button onClick={() => void store.refresh()}>{t('retry')}</button></div>}
    {!snapshot.loading && !snapshot.catalog.vaults.length ? <div className="empty-vault"><Icon name="folder" width="40" height="40" /><h1>{t('noVault')}</h1><p>{t('noVaultHint')}</p></div> : view === 'board' ? <main className="board"><div className="board-intro"><div><p className="eyebrow">{today} · {halfYearPeriod(today)}</p><h1>{t('today')}</h1></div><div className="intro-metrics"><Metric value={tasks.length} label={t('currentActions')} /><Metric value={projects.length} label={t('projects')} /><Metric value={assets.total} label={t('assets')} /></div></div><div className="section-links">{(['today', 'action', 'input', 'knowledge', 'review', 'system'] as const).map(id => <a key={id} href={`#section-${id}`}>{t(id)}</a>)}</div>{layout && <Bento key={vaultId} mobileOrder={mobileOrder} persistMobileOrder={async next => { await store.savePreference(`mobile-order:${vaultId}`, next); setMobileOrder(next); }} initial={layout} render={render} persist={next => store.savePreference(`layout:${vaultId}:${window.__UMEDA_BOOT__?.platform ?? 'desktop'}`, next)} />}</main> : <LibraryFiles key={vaultId} store={store} vaultId={vaultId} files={files} onOpen={(file, location) => file.deleted ? setDeletedSelection(file) : open(file, location)} onCreate={() => setComposer('task')} />}
    {selected && <div className="document-overlay"><DocumentReader key={`${vaultId}:${selected.path}:${selected.revision}`} store={store} vaultId={vaultId} file={selected} files={files} startEditing={editing} initialLocation={searchLocation} onClose={() => setSelected(null)} onOpen={open} notice={setNotice} /></div>}
    {deletedSelection && <TrashHistory store={store} vaultId={vaultId} file={deletedSelection} onClose={() => setDeletedSelection(null)} />}
    {composer && <Composer kind={composer} store={store} vaultId={vaultId} files={files} objects={objects} onClose={() => setComposer(null)} onSaved={path => { setComposer(null); setNotice(t('saved')); const file = store.files(vaultId).find(file => file.path === path); open(file); }} />}
    {notice && <div className="toast" role="status">{notice}</div>}
  </div>;
}

function Composer({ kind, store, vaultId, files, objects, onClose, onSaved }: { kind: string; store: WorkbenchStore; vaultId: string; files: VaultSummary[]; objects: KosObject[]; onClose(): void; onSaved(path: string): void }) {
  const [title, setTitle] = useState(''), [body, setBody] = useState(''), [type, setType] = useState(kind), [project, setProject] = useState(''), [due, setDue] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!title.trim() || busy || !restored) return; setBusy(true);
    try {
      let path: string;
      if (type === 'capture') path = await store.capture(vaultId, title, body);
      else {
        const today = localDay(), safe = title.trim().replace(/[\\/:*?"<>|\x00-\x1f]/g, '-').slice(0, 100);
        const defaults: Record<string, string> = { task: '32_任务', project: '31_项目', goal: `30_目标/${halfYearPeriod(today)}`, knowledge: '22_知识', source: '11_原材料' };
        const existing = objects.find(object => object.type === type && (object.type !== 'goal' || object.period === halfYearPeriod(today)));
        const directory = existing?.filePath.split('/').slice(0, -1).join('/') || defaults[type];
        path = `${directory}/${safe}-${uniqueId().slice(-8)}.md`;
        const metadata: Record<string, unknown> = { type, title: title.trim(), created: today, tags: [] };
        if (type === 'task') Object.assign(metadata, { status: 'todo', priority: 'P2', projects: project ? [`[[${project}]]`] : [], due: due || null, scheduled_for: null });
        else if (type === 'goal') Object.assign(metadata, { status: 'draft', period: halfYearPeriod(today), allocation_weight: 0 });
        else if (type === 'project') Object.assign(metadata, { status: 'idea', priority: 'P2', process_metrics: [], result_metrics: [] });
        else if (type === 'source') Object.assign(metadata, { status: 'captured', format: 'article' });
        else metadata.status = 'draft';
        await store.saveText(vaultId, path, patchMarkdown('', metadata, `\n# ${title.trim()}\n\n${body}\n`), 0);
      }
      await store.savePreference(`composer:${vaultId}`, null); onSaved(path);
    } catch (error) { setError(error instanceof Error ? error.message : t('saveError')); } finally { setBusy(false); }
  };
  const draftKey = `composer:${vaultId}`;
  const [restored, setRestored] = useState(false);
  const draftRef = useRef({ title, body, type, project, due }); draftRef.current = { title, body, type, project, due };
  const persistDraft = () => restored ? store.savePreference(draftKey, draftRef.current) : Promise.resolve();
  useEffect(() => { let alive = true; void store.preference<typeof draftRef.current | null>(draftKey, null).then(draft => { if (alive && draft) { setTitle(draft.title); setBody(draft.body); setType(draft.type ?? kind); setProject(draft.project ?? ''); setDue(draft.due ?? ''); } if (alive) setRestored(true); }).catch(() => { if (alive) setError(t('readError')); }); return () => { alive = false; }; }, [store, draftKey]);
  useEffect(() => beforeLeave(persistDraft), [store, draftKey]);
  useEffect(() => { if (!restored) return; const timer = setTimeout(() => { void persistDraft().catch(() => setError(t('saveError'))); }, 400); return () => clearTimeout(timer); }, [store, restored, title, body, type, project, due]);
  const close = async () => { try { await persistDraft(); onClose(); } catch { setError(t('saveError')); } };
  const dialogRef = useModalDialog(close);
  return <div className="modal-backdrop"><section ref={dialogRef} className="composer modal" role="dialog" aria-modal="true" aria-label={t('newDocument')}><header><h2>{type === 'capture' ? t('capture') : t('newDocument')}</h2><button className="icon-button" onClick={() => void close()} aria-label={t('close')}><Icon name="close" /></button></header><form onSubmit={event => void save(event)}><label>{t('type')}<select value={type} onChange={event => setType(event.target.value)}>{(['capture', 'task', 'project', 'goal', 'knowledge', 'source'] as const).map(value => <option key={value} value={value}>{t(value)}</option>)}</select></label><label>{t('title')}<input disabled={!restored} autoFocus value={title} onChange={event => setTitle(event.target.value)} maxLength={160} required /></label>{type === 'task' && <div className="form-row"><label>{t('related')}<select value={project} onChange={event => setProject(event.target.value)}><option value="">{t('none')}</option>{objects.filter(object => object.type === 'project').map(object => <option key={object.filePath} value={object.filePath}>{displayTitle(files.find(file => file.path === object.filePath)!)}</option>)}</select></label><label>{t('due')}<input type="date" value={due} onChange={event => setDue(event.target.value)} /></label></div>}<label>{t('content')}<textarea disabled={!restored} value={body} onChange={event => setBody(event.target.value)} rows={8} /></label>{error && <p className="error-notice">{error}</p>}<footer><small>{t('templateNote')}</small><button className="primary" disabled={busy || !restored || !title.trim()}>{busy ? t('processing') : t('save')}</button></footer></form></section></div>;
}

function TrashHistory({ store, vaultId, file, onClose }: { store: WorkbenchStore; vaultId: string; file: VaultSummary; onClose(): void }) {
  const dialog = useModalDialog(async () => onClose());
  return <div className="document-overlay"><article ref={dialog} className="document-reader" role="dialog" aria-modal="true" aria-label={t('trash')}>
    <header className="reader-header"><h2>{displayTitle(file)}</h2><button onClick={onClose}>{t('close')}</button></header>
    <div className="trash-history"><VersionHistory store={store} vaultId={vaultId} file={file} onRestored={onClose} /></div>
  </article></div>;
}
