import {
  resolveAppearanceScheme,
  type AppearanceBrandStyle,
  type AppearanceSchemeId,
} from '@cindy/maker-shared/appearance-scheme';
import { isLocalThemeId } from '../../shared/local-themes';
import type { Theme, ThemeBrandAsset, ThemeType } from '@/themes/types';
import headDark from '@/assets/head-image-dark.png';
import headLight from '@/assets/head-image-light.png';
import logoDark from '@/assets/logo-dark.png';
import logoLight from '@/assets/logo-light.png';
import minimalDark from '@/assets/umeda-wordmark-dark.svg';
import minimalLight from '@/assets/umeda-wordmark-light.svg';
import shareCharacter from '@/assets/cindy-share-character.jpg';

export { logoDark, logoLight };

/** Semantic asset slots. New schemes are wired here, rather than in each consumer. */
const packs = {
  illustrated: {
    light: { icon: { src: headLight }, logo: { src: logoLight } },
    dark: { icon: { src: headDark }, logo: { src: logoDark } },
    shareCharacter,
  },
  typographic: {
    light: { icon: null, logo: { src: minimalLight } },
    dark: { icon: null, logo: { src: minimalDark } },
    shareCharacter: undefined,
  },
} satisfies Record<
  AppearanceBrandStyle,
  {
    light: { icon: ThemeBrandAsset | null; logo: ThemeBrandAsset };
    dark: { icon: ThemeBrandAsset | null; logo: ThemeBrandAsset };
    shareCharacter?: string;
  }
>;

export function resolveBrandAssets(
  schemeId: AppearanceSchemeId,
  type: ThemeType,
  theme: Theme | null,
) {
  const scheme = resolveAppearanceScheme(schemeId);
  const pack = packs[scheme.brandStyle];
  const defaults = pack[type];
  // Explicit local theme artwork remains an override. Built-in Cindy artwork belongs
  // to the original pack and must not leak into the minimal scheme.
  const custom =
    theme && (scheme.brandStyle === 'illustrated' || isLocalThemeId(theme.id))
      ? theme.brand
      : undefined;
  return {
    icon: custom?.icon ?? defaults.icon,
    logo: custom?.logo ?? defaults.logo,
    defaultIcon: defaults.icon,
    defaultLogo: defaults.logo,
    // Existing loading/share wordmarks did not consume local home-page artwork.
    wordmark: defaults.logo,
    shareCharacter: pack.shareCharacter,
  };
}
