import packaging from '../../packaging.json';
import type { CindyRegion } from '@cindy/maker-shared/brand-identity';

export const DESKTOP_PACKAGE_PRODUCT = packaging.product;

/** Package paths and visible names; never use these for storage or credentials. */
export function desktopPackageName(region: CindyRegion = 'global'): string {
  return packaging.executableNameByRegion[region];
}

/** Keep the Linux managed-installer executable contract until a separate migration. */
export function desktopPackageBinaryName(region: CindyRegion, platform: string): string {
  return platform === 'linux' ? packaging.linuxExecutableNameByRegion[region] : desktopPackageName(region);
}
