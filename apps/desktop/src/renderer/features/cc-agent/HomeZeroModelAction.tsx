import { Button } from '@/components/ui/button';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/** Personal startup connects directly to the owner’s model provider. */
export function HomeZeroModelAction({
  narrow,
}: {
  authMode: 'signed-out' | 'local' | 'cloud';
  narrow: boolean;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <div data-testid="home-zero-model" className="mt-4 w-full">
      <div
        className={cn(
          'flex w-full items-center gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-[18px] py-4',
          narrow && 'flex-col items-stretch',
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <p className="text-15 font-medium leading-snug text-[var(--text-primary)]">
            {t('onboarding.connectProvider.title')}
          </p>
          <p className="text-13 leading-relaxed text-[var(--text-secondary)]">
            {t('onboarding.connectProvider.desc')}
          </p>
        </div>
        <Button
          variant="cta"
          size="lg"
          compact
          type="button"
          data-testid="home-zero-model-cta"
          onClick={() => navigate('/settings?tab=providers&wizard=1')}
          className={cn(narrow && 'self-end')}
        >
          {t('onboarding.connectProvider.banner.connectCta')}
        </Button>
      </div>
    </div>
  );
}
