import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkSyncStatus, WorkConflict } from '@cindy/maker-shared/work-replication';
import { Button } from '@/components/ui/button';
import { useWorkOwner } from './client';
import { WorkMarkdown } from './WorkMarkdown';

export function WorkSyncPanel({ version }: { version: number }) {
  const owner = useWorkOwner(), { t } = useTranslation();
  const [status, setStatus] = useState<WorkSyncStatus | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [details, setDetails] = useState<Record<string, WorkConflict>>({});
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    const api = window.electronAPI?.workManagement;
    if (api?.syncStatus) void api.syncStatus(owner).then(value => { if (live) setStatus(value); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [version, refresh, owner.dataOwnerId, owner.ownerGeneration]);
  if (!status) return null;
  const resolve = async (id: string, choice: 'local' | 'remote') => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await window.electronAPI.workManagement.resolveSync?.(id, choice, owner); setRefresh(v => v + 1); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <div className="max-h-[40vh] shrink-0 overflow-y-auto border-b border-[var(--border-default)] px-5 py-3 text-sm text-[var(--text-secondary)]" aria-live="polite">
    {status.error && <p className="mb-2">{t('umedaWork.sync.paused')}</p>}
    <p>{status.conflicts.length ? t('umedaWork.sync.conflicts', { count: status.conflicts.length }) : status.queued ? t('umedaWork.sync.queued', { count: status.queued }) : status.scope ? t('umedaWork.sync.saved') : t('umedaWork.sync.local')}</p>
    {status.conflicts.map(conflict => <details key={conflict.request_id} className="mt-3" onToggle={event => { if (event.currentTarget.open) void window.electronAPI.workManagement.syncConflict?.(conflict.request_id, owner).then(value => setDetails(current => ({ ...current, [conflict.request_id]: value }))).catch(() => setError(true)); }}>
      <summary className="cursor-pointer py-2 text-[var(--text-primary)]">{conflict.summary}</summary>
      <p className="my-2">{t('umedaWork.sync.explanation')}</p>
      <div className="grid gap-4 md:grid-cols-2">{(['local', 'remote'] as const).map(side => <div key={side}>
        <h3 className="mb-2 font-medium text-[var(--text-primary)]">{t(`umedaWork.sync.${side}Version`)}</h3>
        {(details[conflict.request_id]?.[side] ?? []).map(value => <section key={value.id} className="mb-3"><p>{value.title} · {t(`umedaWork.state.${value.status}`)}{value.progress ? ` · ${value.progress.percent}%` : ''}</p><WorkMarkdown content={value.description} title={value.title} /></section>)}
      </div>)}</div>
      <div className="my-3 flex flex-wrap gap-2"><Button variant="secondary" disabled={busy} onClick={() => void resolve(conflict.request_id, 'local')}>{t('umedaWork.sync.keepLocal')}</Button><Button variant="secondary" disabled={busy} onClick={() => void resolve(conflict.request_id, 'remote')}>{t('umedaWork.sync.useRemote')}</Button></div>
    </details>)}
    {error && <p role="alert" className="mt-2">{t('umedaWork.sync.failed')}</p>}
  </div>;
}
