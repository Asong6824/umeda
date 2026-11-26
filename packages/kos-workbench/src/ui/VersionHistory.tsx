import { useEffect, useState } from 'react';
import type { VaultFile, VaultSummary } from '@cindy/device-link';
import type { LibraryModel as WorkbenchStore } from '../library/model';
import { EDIT_MAX_BYTES } from '../documents';
import { t } from '../messages';

export function VersionHistory({ store, vaultId, file, onRestored }: { store: WorkbenchStore; vaultId: string; file: VaultSummary; onRestored(): void }) {
  const [versions, setVersions] = useState<VaultFile[]>([]), [selected, setSelected] = useState<VaultFile | null>(null);
  const [text, setText] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false), [before, setBefore] = useState<number | undefined>(), [retry, setRetry] = useState(0);
  const canPreview = !!selected && /\.(md|txt|json|ya?ml|csv)$/i.test(file.path) && selected.size <= EDIT_MAX_BYTES;
  useEffect(() => {
    let alive = true;
    setBusy(true); setError('');
    const load = async () => {
      let cursor: string | undefined;
      while (alive) {
        const result = await store.history(vaultId, file.path, before);
        if (!alive) return;
        setVersions(previous => before ? [...new Map([...previous, ...result.files].map(file => [file.revision, file])).values()] : result.files);
        setMore(result.more);
        if (!result.indexing) return;
        if (!result.indexCursor || result.indexCursor === cursor) throw new Error('HISTORY_INDEX_STALLED');
        cursor = result.indexCursor;
      }
    };
    void load().catch(() => { if (alive) setError(t('readError')); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [store, vaultId, file.path, before, retry]);
  useEffect(() => {
    let alive = true;
    setText('');
    if (selected && !selected.deleted && canPreview)
      void store.readVersion(vaultId, selected).then(value => { if (alive) setText(value); }).catch(() => { if (alive) setError(t('readError')); });
    return () => { alive = false; };
  }, [store, vaultId, selected, canPreview]);
  const restore = async () => {
    if (!selected) return;
    setBusy(true); setError('');
    try { await store.restore(vaultId, file.path, selected.revision, file.revision); onRestored(); }
    catch (error) { const status = (error as { status?: number })?.status; setError(status === 409 ? t('versionChanged') : status === 423 ? t('syncBeforeRestore') : t('saveError')); }
    finally { setBusy(false); }
  };
  return <section className="version-history" aria-label={t('versionHistory')}>
    <p>{t('restoreHint')}</p>
    {error && <p role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>{t('retry')}</button></p>}
    {versions.map(version => <button key={version.revision} aria-pressed={selected?.revision === version.revision} onClick={() => { setError(''); setSelected(version); }}>
      <span>{new Date(version.modifiedAt).toLocaleString()}</span><small> · {version.revision}{version.deleted ? ` · ${t('deletedVersion')}` : ''}</small>
    </button>)}
    {busy && <p role="status">{t('processing')}</p>}{more && <button disabled={busy} onClick={() => setBefore(versions.at(-1)?.revision)}>{t('loadMore')}</button>}
    {selected && !selected.deleted && <>
      {canPreview ? <label>{t('versionPreview')}<textarea readOnly value={text} rows={10} /></label> : <p>{t('versionPreviewUnavailable')}</p>}
      <button className="primary" disabled={busy || selected.revision === file.revision} onClick={() => void restore()}>{t('restoreVersion')}</button>
    </>}
  </section>;
}
