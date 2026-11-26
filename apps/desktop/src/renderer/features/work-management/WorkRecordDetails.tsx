import * as Dialog from '@radix-ui/react-dialog';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkItemSummary, WorkProgressRecord } from '@cindy/maker-shared/work-management';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { requestWork, useWorkOwner } from './client';
import { WorkMarkdown } from './WorkMarkdown';
import { splitWorkDescription } from './description';

export function WorkRecordDetails({ requestId, targets, close, openItem }: { requestId: string; targets: readonly WorkItemSummary[]; close(): void; openItem(item: Pick<WorkItemSummary, 'id' | 'kind'>): void }) {
  const owner = useWorkOwner(), { t } = useTranslation();
  const [record, setRecord] = useState<WorkProgressRecord | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true; setRecord(null); setFailed(false);
    void requestWork({ operation: 'record', request_id: requestId }, owner).then(result => {
      if (live) { if (result.record) setRecord(result.record); else setFailed(true); }
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [requestId, owner.dataOwnerId, owner.ownerGeneration, attempt]);
  return <Dialog.Root open onOpenChange={open => { if (!open) close(); }}><Dialog.Portal>
    <Dialog.Overlay className="modal-scrim fixed inset-0 z-50" />
    <Dialog.Content className="modal-panel fixed inset-0 z-50 m-auto flex h-fit max-h-[85vh] w-[min(680px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5 text-[var(--text-primary)]">
      <Dialog.Title className="text-lg font-medium">{t('umedaWork.recordDetails')}</Dialog.Title>
      <Dialog.Description className="mt-1 text-sm text-[var(--text-secondary)]">{record ? `${new Date(record.created_at).toLocaleString()} · ${record.actor.kind === 'user' ? t('umedaWork.byYou') : 'agent_kind' in record.actor ? record.actor.agent_kind : t('umedaWork.byAgent')}` : t('umedaWork.history')}</Dialog.Description>
      <div className="mt-5 min-h-0 overflow-y-auto">
        {!record ? failed ? <div role="alert" className="flex items-center justify-between gap-3 text-sm"><span>{t('umedaWork.loadFailed')}</span><Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>{t('umedaWork.retry')}</Button></div> : <div className="flex justify-center p-6"><Spinner /></div> : <>
          <WorkMarkdown content={record.operation === 'create' ? t('umedaWork.createdSummary', { title: record.changes[0]?.after.title }) : record.summary} />
          <div className="mt-5 space-y-4">{record.changes.map(({ before, after }) => <section key={after.id} className="border-t border-[var(--border-default)] pt-4">
            <Button variant="secondary" onClick={() => { close(); openItem(after); }}>{after.title}</Button>
            {(!before || before.status !== after.status) && <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('umedaWork.status')}: {before && <>{t(`umedaWork.state.${before.status}`)} → </>}{t(`umedaWork.state.${after.status}`)}</p>}
            {before && before.title !== after.title && <p className="mt-2 break-words text-sm">{t('umedaWork.name')}: {before.title} → {after.title}</p>}
            {JSON.stringify(before?.progress ?? null) !== JSON.stringify(after.progress) && <p className="mt-2 text-sm">{t('umedaWork.progress')}: {after.progress ? `${after.progress.percent}% · ${after.progress.basis}` : '—'}</p>}
            {(['project', 'goal'] as const).map(kind => {
              const oldIds = before?.[`${kind}_ids`] ?? [], newIds = after[`${kind}_ids`];
              if (JSON.stringify(oldIds) === JSON.stringify(newIds)) return null;
              return <div key={kind} className="mt-3 text-sm"><p className="mb-2 text-[var(--text-secondary)]">{t(`umedaWork.tabs.${kind}`)}</p><div className="flex flex-wrap items-center gap-2">
                {oldIds.length > 0 && <span className="text-[var(--text-secondary)]">{oldIds.map(id => targets.find(target => target.id === id)?.title ?? t('umedaWork.openRelated')).join(' / ')} →</span>}
                {newIds.length ? newIds.map(id => <Button key={id} variant="secondary" onClick={() => { close(); openItem({ id, kind }); }}>{targets.find(target => target.id === id)?.title ?? t('umedaWork.openRelated')}</Button>) : <span>—</span>}
              </div></div>;
            })}
            {before?.description !== after.description && (splitWorkDescription(after.description).body ? <details className="mt-3 text-sm"><summary className="min-h-8 cursor-pointer text-[var(--text-secondary)]">{t('umedaWork.description')}</summary><div className="mt-2"><WorkMarkdown content={after.description} title={after.title} /></div></details> : before?.description ? <p className="mt-2 text-sm">{t('umedaWork.description')}: —</p> : null)}
          </section>)}</div>
          {record.verification.length > 0 && <section className="mt-5 border-t border-[var(--border-default)] pt-4"><h3 className="text-sm font-medium">{t('umedaWork.verification')}</h3><ul className="mt-3 space-y-3">{record.verification.map((value, index) => <li key={index} className="text-sm"><p>{value.description}</p><p className="mt-1 text-xs text-[var(--text-secondary)]">{t(`umedaWork.verificationState.${value.outcome}`)}</p>{value.evidence && <div className="mt-2"><WorkMarkdown content={value.evidence} /></div>}</li>)}</ul></section>}
        </>}
      </div>
      <div className="mt-5 flex shrink-0 justify-end"><Button variant="secondary" onClick={close}>{t('umedaWork.close')}</Button></div>
    </Dialog.Content>
  </Dialog.Portal></Dialog.Root>;
}
