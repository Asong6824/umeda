import { useEffect, useRef, useState } from 'react';
import { isVaultPath, type VaultSummary } from '@cindy/device-link';
import type { LibraryModel, StorageReport } from '../library/model';
import { t } from '../messages';
import { useModalDialog } from './useModalDialog';

export function MoveDocument({ store, vaultId, file, onClose }: { store: LibraryModel; vaultId: string; file: VaultSummary; onClose(): void }) {
  const [path, setPath] = useState(file.path), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const saving = useRef(false), input = useRef<HTMLInputElement>(null);
  const close = async () => { if (!saving.current) onClose(); };
  const dialog = useModalDialog(close);
  const submit = async () => {
    if (saving.current) return;
    if (!isVaultPath(path) || path === file.path) { setError(t('moveInvalidPath')); input.current?.focus(); return; }
    saving.current = true; setBusy(true); setError('');
    try { await store.move(vaultId, file.path, path, file.revision); onClose(); }
    catch (error) { setError((error as { status?: number }).status === 409 ? t('moveChanged') : t('moveFailed')); }
    finally { saving.current = false; setBusy(false); }
  };
  return <div className="modal-backdrop modal-scrim"><section ref={dialog} className="composer modal library-tool" role="dialog" aria-modal="true" aria-labelledby="move-heading">
    <h2 id="move-heading">{t('moveDocument')}</h2><p>{file.path}</p>
    <form onSubmit={event => { event.preventDefault(); void submit(); }} aria-busy={busy}>
      <label htmlFor="move-path">{t('destinationPath')}</label><input ref={input} id="move-path" value={path} disabled={busy} onChange={event => setPath(event.target.value)} aria-invalid={!!error} aria-describedby="move-help move-error" />
      <p id="move-help">{t('moveHint')}</p><p id="move-error" role="alert">{error}</p>
      <footer><button type="button" disabled={busy} onClick={() => void close()}>{t('close')}</button><button className="primary" disabled={busy} type="submit">{busy ? t('processing') : t('moveDocument')}</button></footer>
    </form>
  </section></div>;
}

const size = (bytes: number) => `${(bytes / (1024 * 1024)).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB`;
export function LibrarySpace({ store, onClose }: { store: LibraryModel; onClose(): void }) {
  const [report, setReport] = useState<StorageReport | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(true), [retry, setRetry] = useState(0);
  const dialog = useModalDialog(async () => onClose());
  useEffect(() => {
    let alive = true; setBusy(true); setError('');
    void store.storageReport().then(value => { if (alive) setReport(value); }, () => { if (alive) setError(t('readError')); }).finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [store, retry]);
  return <div className="modal-backdrop modal-scrim"><section ref={dialog} className="composer modal library-tool" role="dialog" aria-modal="true" aria-labelledby="space-heading">
    <h2 id="space-heading">{t('storageSpace')}</h2><p>{t('storageScope')}</p>
    {busy && <p role="status">{t('processing')}</p>}{error && <p role="alert">{error}</p>}
    {report && <dl>{(['cacheBytes', 'pinnedBytes', 'pendingBytes', 'cacheOnlyBytes'] as const).map(key => <div key={key}><dt>{t(key)}</dt><dd>{size(report[key])}</dd></div>)}</dl>}
    {!busy && !report && !error && <p>{t('storageUnavailable')}</p>}<p>{t('storageRetention')}</p>
    <footer><button disabled={busy} onClick={() => setRetry(value => value + 1)}>{t('refresh')}</button><button onClick={onClose}>{t('close')}</button></footer>
  </section></div>;
}
