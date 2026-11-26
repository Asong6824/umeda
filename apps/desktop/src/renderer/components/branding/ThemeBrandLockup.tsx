import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import type { AppearanceSchemeId } from '@cindy/maker-shared/appearance-scheme';
import { useBrandAssets } from '@/appearance/useBrandAssets';
import { cn } from '@/lib/utils';
import type { Theme, ThemeBrandAsset } from '@/themes/types';

/**
 * ThemeBrandLockup — 新建页的品牌组件，素材由代码中的外观方案提供。
 *
 * 原有布局为 50px icon + 110×37.5px logo；简洁方案允许省略 icon。
 * 本地主题只替换素材，不提供尺寸配置；loader 提供的透明像素边界会在
 * 这里无损裁掉画布留白，原始文件不会被改写。
 */

export const BRAND_ICON_SIZE = 50;
export const BRAND_LOGO_WIDTH = 110;
export const BRAND_LOGO_HEIGHT = 37.5;
export const BRAND_LOCKUP_GAP = 9;

interface CroppedAssetImageProps {
  asset: ThemeBrandAsset;
  boxWidth: number;
  boxHeight: number;
  fit: 'contain' | 'cover';
  alt: string;
  onError: () => void;
}

function CroppedAssetImage({
  asset,
  boxWidth,
  boxHeight,
  fit,
  alt,
  onError,
}: CroppedAssetImageProps) {
  const style = useMemo<CSSProperties>(() => {
    const bounds = asset.visibleBounds;
    if (!bounds) {
      return {
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: fit,
      };
    }
    const scale =
      fit === 'cover'
        ? Math.max(boxWidth / bounds.width, boxHeight / bounds.height)
        : Math.min(boxWidth / bounds.width, boxHeight / bounds.height);
    const visibleWidth = bounds.width * scale;
    const visibleHeight = bounds.height * scale;
    return {
      width: bounds.sourceWidth * scale,
      height: bounds.sourceHeight * scale,
      maxWidth: 'none',
      left: (boxWidth - visibleWidth) / 2 - bounds.x * scale,
      top: (boxHeight - visibleHeight) / 2 - bounds.y * scale,
    };
  }, [asset.visibleBounds, boxHeight, boxWidth, fit]);

  return (
    <img
      src={asset.src}
      alt={alt}
      className="pointer-events-none absolute select-none"
      style={style}
      draggable={false}
      onError={onError}
    />
  );
}

export interface ThemeBrandLockupProps {
  theme: Theme | null;
  schemeId?: AppearanceSchemeId;
  className?: string;
  testId?: string;
}

export function ThemeBrandLockup({ theme, schemeId, className, testId }: ThemeBrandLockupProps) {
  const assets = useBrandAssets(theme, schemeId);
  const { defaultIcon, defaultLogo } = assets;
  const customIcon = assets.icon;
  const customLogo = assets.logo;
  const [iconFailed, setIconFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);

  useEffect(() => setIconFailed(false), [customIcon, defaultIcon?.src]);
  useEffect(() => setLogoFailed(false), [customLogo, defaultLogo.src]);

  const icon = customIcon && !iconFailed ? customIcon : defaultIcon;
  const logo = customLogo && !logoFailed ? customLogo : defaultLogo;
  const iconIsCustom = icon !== defaultIcon;

  return (
    <div data-testid={testId} className={cn('flex h-[50px] items-center gap-[9px]', className)}>
      {icon ? <span
        data-testid={testId ? `${testId}-icon` : undefined}
        className={cn(
          'pointer-events-none relative h-[50px] w-[50px] shrink-0 select-none overflow-hidden rounded-full',
          iconIsCustom && 'border border-[var(--border-default)] bg-[var(--surface-elevated)]',
        )}
        style={{ filter: 'drop-shadow(0 2px 3.65px rgba(0, 0, 0, 0.15))' }}
      >
        <CroppedAssetImage
          asset={icon}
          boxWidth={BRAND_ICON_SIZE}
          boxHeight={BRAND_ICON_SIZE}
          fit="cover"
          alt=""
          onError={() => setIconFailed(true)}
        />
      </span> : null}
      <span
        data-testid={testId ? `${testId}-logo` : undefined}
        className="relative h-[37.5px] w-[110px] shrink-0 overflow-hidden"
      >
        <CroppedAssetImage
          asset={logo}
          boxWidth={BRAND_LOGO_WIDTH}
          boxHeight={BRAND_LOGO_HEIGHT}
          fit="contain"
          alt="Umeda"
          onError={() => setLogoFailed(true)}
        />
      </span>
    </div>
  );
}
