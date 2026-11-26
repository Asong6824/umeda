/**
 * Wordmark follows the code-selected appearance scheme and theme mode.
 */

import { useBrandAssets } from '@/appearance/useBrandAssets';
export { logoLight, logoDark } from '@/appearance/brandAssets';

/** 返回当前主题下应显示的品牌 logo URL(可直接用于 <img src>)。 */
export function useBrandLogo(): string {
  return useBrandAssets().wordmark.src;
}
