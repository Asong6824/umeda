import { WorkSyncPanel } from './WorkSyncPanel';
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createId } from '@paralleldrive/cuid2';
import { Check, Circle, Folder, Flag, Plus, Pencil, ArrowLeft, RefreshCw, ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { WorkItem, WorkItemKind, WorkItemSummary, WorkManagementRequest, WorkRecordSummary } from '@cindy/maker-shared/work-management';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { requestWork, sameWorkOwner, useWorkAvailability, useWorkOwner } from './client';
import { WorkItemForm } from './WorkItemForm';
import { WorkMarkdown } from './WorkMarkdown';
import { WorkRecordDetails } from './WorkRecordDetails';

const KINDS: WorkItemKind[] = ['task', 'project', 'goal'];
const emptyCatalog = (): Record<WorkItemKind, WorkItemSummary[]> => ({ task: [], project: [], goal: [] });

function WorkPageContent() {
  const { t } = useTranslation(), owner = useWorkOwner(), availability = useWorkAvailability(), available = availability === true;
  const [kind, setKind] = useState<WorkItemKind>('task'), [query, setQuery] = useState(''), deferredQuery = useDeferredValue(query);
  const [catalog, setCatalog] = useState(emptyCatalog), [next, setNext] = useState<Partial<Record<WorkItemKind, string | null>>>({});
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [version, setVersion] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null), [item, setItem] = useState<WorkItem | null>(null);
  const [records, setRecords] = useState<WorkRecordSummary[]>([]), [before, setBefore] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false), [editing, setEditing] = useState<{ kind: WorkItemKind; item?: WorkItem } | null>(null);
  const [relatedTasks, setRelatedTasks] = useState<WorkItemSummary[]>([]), [relatedProjects, setRelatedProjects] = useState<WorkItemSummary[]>([]);
  const [relatedNext, setRelatedNext] = useState<string | null>(null);
  const [projectsNext, setProjectsNext] = useState<string | null>(null);
  const [activeRecord, setActiveRecord] = useState<string | null>(null);
  const detailPane = useRef<HTMLElement>(null), workScroll = useRef<HTMLDivElement>(null);
  const [showCompleted, setShowCompleted] = useState(false), [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const locks = useRef(new Set<string>()), currentOwner = useRef(owner), pages = useRef<Record<WorkItemKind, number>>({ task: 1, project: 1, goal: 1 });
  const alive = useRef(true);
  const detailIdentity = useRef('');
  detailIdentity.current = `${selectedId}:${version}`;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  currentOwner.current = owner;
  useLayoutEffect(() => {
    if (detailPane.current) detailPane.current.scrollTop = 0;
    if (workScroll.current) workScroll.current.scrollTop = 0;
    setActiveRecord(null);
  }, [selectedId]);
  const refresh = useCallback(() => setVersion(v => v + 1), []);
  useEffect(() => {
    setCatalog(emptyCatalog()); setNext({}); setSelectedId(null); setItem(null); setEditing(null); setRecords([]); setError(''); setRelatedTasks([]); setRelatedProjects([]);
    locks.current.clear(); setBusyIds(new Set());
    pages.current = { task: 1, project: 1, goal: 1 };
  }, [owner.dataOwnerId, owner.ownerGeneration]);
  useEffect(() => {
    const api = window.electronAPI?.workManagement;
    if (!available || !api) return;
    return api.onChanged(stamp => { if (sameWorkOwner(stamp, currentOwner.current)) refresh(); });
  }, [available, refresh]);
  useEffect(() => {
    if (!available) return;
    let live = true;
    setLoading(true);
    const load = async () => {
      const data = await Promise.all(KINDS.map(async group => {
        const items: WorkItemSummary[] = [];
        let after: string | null | undefined;
        for (let n = 0; n < pages.current[group]; n++) {
          if (!live) return { group, items, after: null };
          const page = await requestWork({ operation: 'list', kind: group, limit: 50, ...(group === kind && deferredQuery.trim() ? { query: deferredQuery.trim() } : {}), ...(after ? { after } : {}) }, owner);
          items.push(...(page.items ?? [])); after = page.next_after;
          if (!after) break;
        }
        return { group, items, after: after ?? null };
      }));
      if (!live || !sameWorkOwner(owner, currentOwner.current)) return;
      setCatalog(Object.fromEntries(data.map(v => [v.group, v.items])) as Record<WorkItemKind, WorkItemSummary[]>);
      setNext(Object.fromEntries(data.map(v => [v.group, v.after]))); setError('');
    };
    void load().catch(() => { if (live) setError(t('umedaWork.loadFailed')); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [available, kind, deferredQuery, version, owner.dataOwnerId, owner.ownerGeneration, t]);
  useEffect(() => {
    if (!available || !selectedId) { setItem(null); return; }
    let live = true;
    setDetailLoading(true);
    void requestWork({ operation: 'get', id: selectedId }, owner).then(async result => {
      if (!live || !sameWorkOwner(owner, currentOwner.current)) return;
      setItem(result.item ?? null); setRecords(result.records ?? []); setBefore(result.next_before_record ?? null);
      setRelatedTasks([]); setRelatedProjects([]); setRelatedNext(null); setProjectsNext(null);
      if (result.item && result.item.kind !== 'task') {
        const filter = result.item.kind === 'project' ? { project_id: selectedId } : { goal_id: selectedId };
        const [tasks, projects] = await Promise.all([requestWork({ operation: 'list', kind: 'task', limit: 50, ...filter }, owner),
          result.item.kind === 'goal' ? requestWork({ operation: 'list', kind: 'project', goal_id: selectedId, limit: 50 }, owner) : Promise.resolve(null)]);
        if (!live || !sameWorkOwner(owner, currentOwner.current)) return;
        setRelatedTasks(tasks.items ?? []); setRelatedNext(tasks.next_after ?? null); setRelatedProjects(projects?.items ?? []); setProjectsNext(projects?.next_after ?? null);
      }
    }).catch(() => { if (live) setError(t('umedaWork.loadFailed')); }).finally(() => { if (live) setDetailLoading(false); });
    return () => { live = false; };
  }, [available, selectedId, version, owner.dataOwnerId, owner.ownerGeneration, t]);
  const save = async (request: WorkManagementRequest) => {
    const result = await requestWork(request, owner);
    if (!alive.current || !sameWorkOwner(owner, currentOwner.current)) throw new Error('Work owner changed');
    refresh(); return result;
  };
  const toggle = async (value: WorkItemSummary) => {
    if (locks.current.has(value.id)) return;
    locks.current.add(value.id); setBusyIds(new Set(locks.current));
    try {
      await save({ operation: 'update', request_id: createId(), summary: t(value.status === 'done' ? 'umedaWork.reopenedSummary' : 'umedaWork.completedSummary', { title: value.title }),
        changes: [{ id: value.id, expected_revision: value.revision, status: value.status === 'done' ? 'todo' : 'done' }] });
    } catch (cause) { if (alive.current && sameWorkOwner(owner, currentOwner.current)) { toast.error(t(extractIpcError(cause)?.code === 'WORK_VERSION_CONFLICT' ? 'umedaWork.conflict' : 'umedaWork.saveFailed')); refresh(); } }
    finally { if (alive.current && sameWorkOwner(owner, currentOwner.current)) { locks.current.delete(value.id); setBusyIds(new Set(locks.current)); } }
  };
  const loadRecords = async () => {
    if (!item || !before || detailLoading) return;
    const identity = detailIdentity.current;
    const current = () => alive.current && identity === detailIdentity.current && sameWorkOwner(owner, currentOwner.current);
    setDetailLoading(true);
    try {
      const result = await requestWork({ operation: 'get', id: item.id, before_record: before }, owner);
      if (current()) { setRecords(old => [...old, ...(result.records ?? [])]); setBefore(result.next_before_record ?? null); }
    } catch { if (current()) toast.error(t('umedaWork.loadFailed')); }
    finally { if (current()) setDetailLoading(false); }
  };
  const selectKind = (value: WorkItemKind) => { setKind(value); setQuery(''); setSelectedId(null); setItem(null); setShowCompleted(false); pages.current[value] = 1; };
  const openRelated = useCallback((value: Pick<WorkItemSummary, 'id' | 'kind'>) => {
    setKind(value.kind); setQuery('');
    // A history record may link back to the object already open at the bottom.
    if (detailPane.current) detailPane.current.scrollTop = 0;
    if (workScroll.current) workScroll.current.scrollTop = 0;
    if (selectedId !== value.id) { setItem(null); setSelectedId(value.id); }
  }, [selectedId]);
  const moreRelated = async (group: 'task' | 'project' = 'task') => {
    const cursor = group === 'task' ? relatedNext : projectsNext;
    if (!item || !cursor || detailLoading) return;
    const identity = detailIdentity.current;
    const current = () => alive.current && identity === detailIdentity.current && sameWorkOwner(owner, currentOwner.current);
    setDetailLoading(true);
    try {
      const result = await requestWork({ operation: 'list', kind: group, limit: 50, after: cursor, ...(item.kind === 'project' ? { project_id: item.id } : { goal_id: item.id }) }, owner);
      if (current()) {
        if (group === 'task') { setRelatedTasks(values => [...values, ...(result.items ?? [])]); setRelatedNext(result.next_after ?? null); }
        else { setRelatedProjects(values => [...values, ...(result.items ?? [])]); setProjectsNext(result.next_after ?? null); }
      }
    } catch { if (current()) toast.error(t('umedaWork.loadFailed')); }
    finally { if (current()) setDetailLoading(false); }
  };
  const targets = useMemo(() => KINDS.flatMap(group => catalog[group]), [catalog]);
  const names = new Map(targets.map(value => [value.id, value.title]));
  const displayed = catalog[kind].filter(value => kind !== 'task' || showCompleted || (value.status !== 'done' && value.status !== 'cancelled'));
  const finished = catalog.task.filter(value => value.status === 'done' || value.status === 'cancelled').length;
  return <section className="flex h-full min-h-0 flex-col bg-[var(--surface)] text-[var(--text-primary)]" aria-label={t('umedaWork.title')}>
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-default)] px-6 py-5">
      <div><h1 className="text-xl font-medium">{t('umedaWork.title')}</h1><p className="mt-1 text-sm text-[var(--text-secondary)]">{t('umedaWork.subtitle')}</p></div>
      <Button disabled={!available} onClick={() => setEditing({ kind })}><Plus size={15} aria-hidden="true" />{t('umedaWork.newItem', { kind: t(`umedaWork.kind.${kind}`) })}</Button>
    </header>
    {available && <WorkSyncPanel version={version} />}
    {availability === null ? <div className="flex justify-center p-8"><Spinner /></div> : !available ? <div className="p-6 text-sm text-[var(--text-secondary)]">{t('umedaWork.unavailable')}</div> : <>
      <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border-default)] px-6 py-3">
        <SegmentedControl value={kind} onValueChange={selectKind} aria-label={t('umedaWork.views')}
          options={KINDS.map(value => ({ value, label: t(`umedaWork.tabs.${value}`) }))} />
        <div className="ml-auto w-full sm:w-64"><Input value={query} onChange={setQuery} maxLength={200} ariaLabel={t('umedaWork.search')} placeholder={t('umedaWork.search')} /></div>
      </div>
      {error && <div role="alert" className="flex items-center justify-between gap-2 px-6 py-3 text-sm text-[var(--error-fg)]">{error}<Button variant="secondary" onClick={refresh}><RefreshCw size={14} />{t('umedaWork.retry')}</Button></div>}
      <div ref={workScroll} className={cn('grid min-h-0 flex-1 grid-cols-1 overflow-y-auto', selectedId && 'xl:grid-cols-[minmax(260px,1fr)_minmax(360px,1.5fr)]')}>
        <div className={cn('min-w-0 p-4 xl:overflow-y-auto', selectedId && 'hidden xl:block')}>
          {kind === 'task' && finished > 0 && <label className="mb-3 flex min-h-8 cursor-pointer items-center gap-2 px-2 text-sm text-[var(--text-secondary)]"><input type="checkbox" className="accent-[var(--text-primary)]" checked={showCompleted} onChange={event => setShowCompleted(event.target.checked)} />{t('umedaWork.showCompleted', { count: finished })}</label>}
          {loading && catalog[kind].length === 0 ? <div className="flex justify-center p-8"><Spinner /></div> : displayed.length === 0 ? <div className="py-16 text-center">
            <p className="text-base font-medium">{t(query.trim() ? 'umedaWork.noResults' : 'umedaWork.empty', { kind: t(`umedaWork.kind.${kind}`) })}</p>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{t('umedaWork.emptyHint')}</p>
          </div> : <ul className="space-y-1" aria-label={t(`umedaWork.tabs.${kind}`)}>{displayed.map(value => <li key={value.id} className={cn('flex items-center gap-1 rounded-lg px-1 hover:bg-[var(--surface-hover)]', selectedId === value.id && 'bg-[var(--surface-chip)]')}>
            {kind === 'task' && <button type="button" role="checkbox" aria-checked={value.status === 'done'} aria-label={t(value.status === 'done' ? 'umedaWork.reopen' : 'umedaWork.complete', { title: value.title })} disabled={busyIds.has(value.id)}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-chip)] disabled:opacity-60" onClick={() => { void toggle(value); }}>
              {busyIds.has(value.id) ? <Spinner size={14} /> : value.status === 'done' ? <Check size={17} /> : <Circle size={17} />}
            </button>}
            <button type="button" onClick={() => { if (selectedId !== value.id) { setItem(null); setSelectedId(value.id); } }} className="flex min-h-16 min-w-0 flex-1 flex-col items-start justify-center gap-1 rounded-lg px-3 py-3 text-left" aria-label={`${value.title} · ${t(`umedaWork.state.${value.status}`)}`} aria-current={selectedId === value.id ? 'true' : undefined}>
              <span className={cn('break-words text-sm font-medium', value.status === 'done' && 'text-[var(--text-tertiary)] line-through')}>{value.title}</span>
              <span className="text-xs text-[var(--text-tertiary)]">{t(`umedaWork.state.${value.status}`)}{value.progress && ` · ${value.progress.percent}%`}</span>
            </button>
          </li>)}</ul>}
          {next[kind] && <div className="mt-4 flex justify-center"><Button variant="secondary" loading={loading} onClick={() => { pages.current[kind]++; refresh(); }}>{t('umedaWork.more')}</Button></div>}
        </div>
        {selectedId && <aside ref={detailPane} className="min-w-0 border-t border-[var(--border-default)] p-6 xl:overflow-y-auto xl:border-t-0 xl:border-l" aria-label={t('umedaWork.details')}>
          <div className="mb-5 flex items-center justify-between gap-2"><Button variant="secondary" onClick={() => { setSelectedId(null); setItem(null); }}><ArrowLeft size={14} />{t('umedaWork.back')}</Button>
            {item && <Button variant="secondary" onClick={() => setEditing({ kind: item.kind, item })}><Pencil size={14} />{t('umedaWork.edit')}</Button>}
          </div>
          {!item ? detailLoading ? <Spinner /> : null : <>
            <div className="flex items-start gap-3">{item.kind === 'project' ? <Folder size={20} className="mt-1 shrink-0 text-[var(--text-secondary)]" /> : item.kind === 'goal' ? <Flag size={20} className="mt-1 shrink-0 text-[var(--text-secondary)]" /> : null}<h2 className="break-words text-xl font-medium">{item.title}</h2></div>
            <p className="mt-2 text-sm text-[var(--text-secondary)]">{t(`umedaWork.state.${item.status}`)}</p>
            {item.progress && <div className="mt-5"><div className="mb-2 flex justify-between text-sm"><span>{t('umedaWork.progress')}</span><span>{item.progress.percent}%</span></div><progress className="h-2 w-full appearance-none overflow-hidden rounded-full bg-[var(--surface-chip)] [&::-webkit-progress-bar]:bg-[var(--surface-chip)] [&::-webkit-progress-value]:bg-[var(--text-primary)] [&::-moz-progress-bar]:bg-[var(--text-primary)]" value={item.progress.percent} max={100} aria-label={t('umedaWork.progress')} /><p className="mt-2 whitespace-pre-wrap text-sm text-[var(--text-secondary)]">{item.progress.basis}</p></div>}
            {item.description && <div className="mt-5"><WorkMarkdown content={item.description} title={item.title} targets={targets} openItem={openRelated} /></div>}
            {(item.project_ids.length > 0 || item.goal_ids.length > 0) && <div className="mt-5 flex flex-wrap gap-2">{[...item.project_ids, ...item.goal_ids].map(id => <Button key={id} variant="secondary" onClick={() => {
              const related = KINDS.flatMap(group => catalog[group]).find(value => value.id === id);
              if (related) openRelated(related); else { setItem(null); setSelectedId(id); }
            }}>{names.get(id) ?? t('umedaWork.openRelated')}</Button>)}</div>}
            {relatedProjects.length > 0 && <section className="mt-6"><h3 className="mb-2 text-sm font-medium">{t('umedaWork.relatedProjects')}</h3><div className="flex flex-wrap gap-2">{relatedProjects.map(value => <Button key={value.id} variant="secondary" onClick={() => openRelated(value)}>{value.title}</Button>)}</div>
              {projectsNext && <Button variant="secondary" loading={detailLoading} className="mt-3" onClick={() => { void moreRelated('project'); }}>{t('umedaWork.more')}</Button>}
            </section>}
            {item.kind !== 'task' && <section className="mt-6"><h3 className="mb-2 text-sm font-medium">{t('umedaWork.relatedTasks')}</h3>
              {relatedTasks.length === 0 ? <p className="text-sm text-[var(--text-tertiary)]">{t('umedaWork.noRelatedTasks')}</p> : <ul className="space-y-1">{relatedTasks.map(value => <li key={value.id} className="flex items-center gap-2">
                <button type="button" role="checkbox" aria-checked={value.status === 'done'} aria-label={t(value.status === 'done' ? 'umedaWork.reopen' : 'umedaWork.complete', { title: value.title })} disabled={busyIds.has(value.id)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-chip)]" onClick={() => { void toggle(value); }}>{value.status === 'done' ? <Check size={16} /> : <Circle size={16} />}</button>
                <button type="button" className="min-h-8 flex-1 rounded-lg text-left text-sm hover:underline" onClick={() => openRelated(value)}>{value.title}</button>
              </li>)}</ul>}
              {relatedNext && <Button variant="secondary" loading={detailLoading} className="mt-3" onClick={() => { void moreRelated(); }}>{t('umedaWork.more')}</Button>}
            </section>}
            <section className="mt-8 border-t border-[var(--border-default)] pt-5" aria-label={t('umedaWork.history')}><h3 className="text-sm font-medium">{t('umedaWork.history')}</h3>
              {records.length === 0 ? <p className="mt-3 text-sm text-[var(--text-tertiary)]">{t('umedaWork.noHistory')}</p> : <ol className="mt-4 space-y-5">{records.map(record => <li key={record.request_id}>
                <button type="button" className="group flex min-h-8 w-full items-start justify-between gap-3 rounded-lg py-1 text-left text-sm leading-relaxed hover:underline focus-visible:outline focus-visible:outline-[var(--focus-ring)]" onClick={() => setActiveRecord(record.request_id)}><span className="whitespace-pre-wrap break-words">{record.operation === 'create' ? t('umedaWork.createdSummary', { title: record.created_title }) : record.summary}</span><ChevronRight size={15} className="mt-1 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" /></button>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">{new Date(record.created_at).toLocaleString()} · {record.actor.kind === 'user' ? t('umedaWork.byYou') : 'agent_kind' in record.actor ? record.actor.agent_kind : t('umedaWork.byAgent')}</p>
              </li>)}</ol>}
              {before && <Button variant="secondary" className="mt-4" loading={detailLoading} onClick={() => { void loadRecords(); }}>{t('umedaWork.more')}</Button>}
            </section>
          </>}
        </aside>}
      </div>
    </>}
    {editing && <WorkItemForm key={`${editing.item?.id ?? 'new'}:${owner.dataOwnerId}:${owner.ownerGeneration}`} {...editing} catalog={catalog} save={save} close={id => { setEditing(null); if (id) { setSelectedId(id); refresh(); } }} />}
    {activeRecord && <WorkRecordDetails key={activeRecord} requestId={activeRecord} targets={targets} close={() => setActiveRecord(null)} openItem={openRelated} />}
  </section>;
}

/** The owner fence remounts the entire editor before a new account can paint. */
export function WorkPage() {
  const owner = useWorkOwner();
  return <WorkPageContent key={`${owner.dataOwnerId}:${owner.ownerGeneration}`} />;
}
