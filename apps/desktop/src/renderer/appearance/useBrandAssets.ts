import { useSyncExternalStore } from 'react';
import {
  ACTIVE_APPEARANCE_SCHEME_ID,
  type AppearanceSchemeId,
} from '@cindy/maker-shared/appearance-scheme';
import { useIsDarkMode } from '@/components/markdown/useIsDarkMode';
import { themeService } from '@/themes/theme-service';
import type { Theme } from '@/themes/types';
import { resolveBrandAssets } from './brandAssets';

const subscribeTheme = (listener: () => void) => themeService.onDidChangeTheme(listener);
const getTheme = () => themeService.getCurrentTheme();

export function useBrandAssets(
  themeOverride?: Theme | null,
  schemeId: AppearanceSchemeId = ACTIVE_APPEARANCE_SCHEME_ID,
) {
  const currentTheme = useSyncExternalStore(subscribeTheme, getTheme, () => null);
  const dark = useIsDarkMode();
  const theme = themeOverride === undefined ? currentTheme : themeOverride;
  return resolveBrandAssets(schemeId, theme?.type ?? (dark ? 'dark' : 'light'), theme);
}
