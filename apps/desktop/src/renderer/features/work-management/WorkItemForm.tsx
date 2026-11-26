import * as Dialog from '@radix-ui/react-dialog';
import { createId } from '@paralleldrive/cuid2';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkItem, WorkItemKind, WorkItemStatus, WorkItemSummary, WorkManagementRequest, WorkManagementResponse } from '@cindy/maker-shared/work-management';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { FormField } from '@/components/ui/form-field';
import { Select } from '@/components/ui/select';
import { extractIpcError } from '@/utils/ipcError';
import { splitWorkDescription } from './description';

export const WORK_STATUSES: WorkItemStatus[] = ['todo', 'doing', 'done', 'blocked', 'cancelled'];
export function WorkItemForm({ kind, item, catalog, save, close }: {
  kind: WorkItemKind; item?: WorkItem; catalog: Record<WorkItemKind, WorkItemSummary[]>;
  save(request: WorkManagementRequest): Promise<WorkManagementResponse>; close(id?: string): void;
}) {
  const { t } = useTranslation();
  const originalDescription = splitWorkDescription(item?.description ?? '');
  const [title, setTitle] = useState(item?.title ?? ''), [description, setDescription] = useState(originalDescription.body);
  const [status, setStatus] = useState<WorkItemStatus>(item?.status ?? 'todo');
  const [projects, setProjects] = useState(item?.project_ids ?? []), [goals, setGoals] = useState(item?.goal_ids ?? []);
  const [percent, setPercent] = useState(item?.progress ? String(item.progress.percent) : ''), [note, setNote] = useState('');
  const [error, setError] = useState(''), [titleError, setTitleError] = useState(false), [progressError, setProgressError] = useState(false), [busy, setBusy] = useState(false);
  const lock = useRef(false), titleRef = useRef<HTMLInputElement>(null);
  const retry = useRef<{ fingerprint: string; request: WorkManagementRequest } | null>(null);
  const dirty = !item || title.trim() !== item.title || description !== originalDescription.body || status !== item.status
    || JSON.stringify(projects) !== JSON.stringify(item.project_ids) || JSON.stringify(goals) !== JSON.stringify(item.goal_ids)
    || percent !== (item.progress ? String(item.progress.percent) : '') || !!note.trim();
  const selectId = (values: string[], id: string, checked: boolean) => checked ? [...new Set([...values, id])] : values.filter(value => value !== id);
  const submit = async () => {
    if (lock.current || !dirty) return;
    setTitleError(!title.trim());
    if (!title.trim()) { titleRef.current?.focus(); return; }
    const progressChanged = !!item && kind !== 'task' && percent !== (item.progress ? String(item.progress.percent) : '');
    const invalidProgress = progressChanged && percent !== '' && (!Number.isFinite(Number(percent)) || Number(percent) < 0 || Number(percent) > 100 || !note.trim());
    setProgressError(invalidProgress);
    if (invalidProgress) return;
    const body = item ? { operation: 'update' as const, summary: note.trim() || t('umedaWork.updatedSummary', { title: title.trim() }), changes: [{
      id: item.id, expected_revision: item.revision,
      ...(title.trim() !== item.title ? { title: title.trim() } : {}),
      ...(description !== originalDescription.body ? { description: description + originalDescription.metadataSuffix } : {}),
      ...(status !== item.status ? { status } : {}),
      ...(JSON.stringify(projects) !== JSON.stringify(item.project_ids) ? { project_ids: projects } : {}),
      ...(JSON.stringify(goals) !== JSON.stringify(item.goal_ids) ? { goal_ids: goals } : {}),
      ...(progressChanged ? { progress: percent === '' ? null : { percent: Number(percent), basis: note.trim() } } : {}),
    }] } : { operation: 'create' as const, kind, title: title.trim(), description, project_ids: projects, goal_ids: goals };
    const fingerprint = JSON.stringify(body);
    const request = retry.current?.fingerprint === fingerprint ? retry.current.request : { ...body, request_id: createId() };
    retry.current = { fingerprint, request };
    lock.current = true; setBusy(true); setError('');
    try {
      let result: WorkManagementResponse;
      try { result = await save(request); }
      catch (cause) {
        // A missing acknowledgement may follow a committed write. One bounded
        // retry of the identical command retrieves its durable original receipt.
        const code = extractIpcError(cause)?.code;
        if (code && code !== 'INTERNAL') throw cause;
        result = await save(request);
      }
      close(item?.id ?? result.items?.[0]?.id);
    } catch (cause) {
      const code = extractIpcError(cause)?.code;
      setError(t(code === 'WORK_VERSION_CONFLICT' ? 'umedaWork.conflict' : 'umedaWork.saveFailed'));
      if (code === 'WORK_VERSION_CONFLICT') retry.current = null;
    } finally { lock.current = false; setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !lock.current) close(); }}>
    <Dialog.Portal><Dialog.Overlay className="modal-scrim fixed inset-0 z-50" />
      <Dialog.Content className="modal-panel fixed inset-0 z-50 m-auto flex h-fit max-h-[85vh] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-[var(--text-primary)]"
        onEscapeKeyDown={event => { if (lock.current) event.preventDefault(); }} onPointerDownOutside={event => { if (lock.current) event.preventDefault(); }}>
        <Dialog.Title className="text-lg font-medium">{t(item ? 'umedaWork.editItem' : 'umedaWork.newItem', { kind: t(`umedaWork.kind.${kind}`) })}</Dialog.Title>
        <Dialog.Description className="mt-1 text-sm text-[var(--text-secondary)]">{t('umedaWork.formHint')}</Dialog.Description>
        <form className="mt-4 flex min-h-0 flex-col gap-4 overflow-y-auto" onSubmit={event => { event.preventDefault(); void submit(); }}>
          <FormField label={t('umedaWork.name')} required error={titleError ? t('umedaWork.nameRequired') : undefined} reserveFeedback>
            {control => <Input {...control} inputRef={titleRef} value={title} onChange={setTitle} maxLength={300} disabled={busy} autoFocus />}
          </FormField>
          <FormField label={t('umedaWork.description')}>
            {control => <Textarea {...control} value={description} onChange={setDescription} rows={4} maxLength={8000 - originalDescription.metadataSuffix.length} disabled={busy} />}
          </FormField>
          {item && <FormField label={t('umedaWork.status')}>
            {control => <Select {...control} label={t('umedaWork.status')} value={status} onValueChange={value => setStatus(value as WorkItemStatus)} disabled={busy}
              options={WORK_STATUSES.map(value => ({ value, label: t(`umedaWork.state.${value}`) }))} />}
          </FormField>}
          {kind !== 'goal' && <details className="text-sm"><summary className="cursor-pointer text-[var(--text-secondary)]">{t('umedaWork.linkOptional')}</summary>
            <div className="mt-3 flex flex-col gap-3">
              {(kind === 'task' ? ['project', 'goal'] as const : ['goal'] as const).map(group => <fieldset key={group} className="flex flex-col gap-2">
                <legend className="mb-2 font-medium">{t(`umedaWork.kind.${group}`)}</legend>
                {catalog[group].length === 0 && <p className="text-[var(--text-tertiary)]">{t('umedaWork.noRelated')}</p>}
                {catalog[group].map(value => <label key={value.id} className="flex min-h-8 cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={(group === 'project' ? projects : goals).includes(value.id)} disabled={busy}
                    className="accent-[var(--text-primary)]" onChange={event => group === 'project' ? setProjects(selectId(projects, value.id, event.target.checked)) : setGoals(selectId(goals, value.id, event.target.checked))} />
                  <span>{value.title}</span>
                </label>)}
              </fieldset>)}
            </div>
          </details>}
          {item && <>
            {kind !== 'task' && <FormField label={t('umedaWork.progress')} hint={t('umedaWork.progressHint')} error={progressError ? t('umedaWork.progressRequired') : undefined}>
              {control => <Input {...control} type="number" min={0} max={100} value={percent} onChange={setPercent} disabled={busy} />}
            </FormField>}
            <FormField label={t('umedaWork.note')}>
              {control => <Textarea {...control} value={note} onChange={setNote} maxLength={kind === 'task' ? 4000 : 2000} rows={3} disabled={busy} />}
            </FormField>
          </>}
          {error && <div role="alert" className="text-sm text-[var(--error-fg)]">{error}</div>}
          <div className="sticky bottom-0 flex justify-end gap-2 bg-[var(--surface-elevated)] pt-2">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => close()}>{t('umedaWork.cancel')}</Button>
            <Button type="submit" loading={busy} disabled={!dirty}>{t('umedaWork.save')}</Button>
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
