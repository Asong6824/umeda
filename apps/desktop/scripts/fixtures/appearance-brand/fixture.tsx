import { useEffect, useSyncExternalStore } from 'react';
import { resolveAppearanceScheme, type AppearanceSchemeId } from '@cindy/maker-shared/appearance-scheme';
import { ThemeBrandLockup } from '../../../src/renderer/components/branding/ThemeBrandLockup';
import { BrandLoadingMark } from '../../../src/renderer/components/branding/BrandLoadingMark';
import { themeService } from '../../../src/renderer/themes/theme-service';
import { mountPage } from '../../ui-page/harness';
import { Button } from '../../../src/renderer/components/ui/button';
import { Input } from '../../../src/renderer/components/ui/input';

const subscribe = (listener: () => void) => themeService.onDidChangeTheme(listener);
const getTheme = () => themeService.getCurrentTheme();

function BrandSurface({ schemeId, loading }: { schemeId?: AppearanceSchemeId; loading: boolean }) {
  const theme = useSyncExternalStore(subscribe, getTheme);
  const scheme = resolveAppearanceScheme(schemeId);
  useEffect(() => { if (theme) themeService.applyTheme(theme, scheme); }, [scheme, theme]);
  return (
    <div className="flex h-full items-center justify-center bg-[var(--surface)] p-8">
      {loading ? <BrandLoadingMark /> : <div data-testid="appearance-tokens" className="flex w-[320px] flex-col items-center gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4">
        <ThemeBrandLockup theme={theme} schemeId={schemeId} testId="appearance-brand" />
        <Input value="Umeda" readOnly aria-label="Umeda" />
        <div className="flex gap-2"><Button>Umeda</Button><Button disabled>Umeda</Button></div>
      </div>}
    </div>
  );
}

mountPage({ render: (ctx) => <BrandSurface schemeId={ctx.data.schemeId as AppearanceSchemeId} loading={ctx.data.loading === true} /> });
