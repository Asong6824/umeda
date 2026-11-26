import { splitMarkdown } from '../documents';
import { t } from '../messages';

export function ReviewChanges({ before, after, busy, accept, keep }: { before: string; after: string; busy: boolean; accept(): void; keep(): void }) {
  return <section className="review-changes" aria-label={t('reviewChanges')}>
    <div className="review-comparison"><label>{t('acceptedVersion')}<textarea aria-label={t('acceptedVersion')} readOnly value={splitMarkdown(before).body} /></label><label>{t('proposedVersion')}<textarea aria-label={t('proposedVersion')} readOnly value={splitMarkdown(after).body} /></label></div>
    <footer><button disabled={busy} onClick={keep}>{t('keepAccepted')}</button><button className="primary" disabled={busy} onClick={accept}>{t('acceptChanges')}</button></footer>
  </section>;
}
