import { colorRegistry } from './color-registry';
import { Emitter } from './event';
import type { ColorIdentifier, ColorValue, Theme } from './types';
import { resolveAppearanceScheme, type AppearanceScheme } from '@cindy/maker-shared/appearance-scheme';
import { isLocalThemeId } from '../../shared/local-themes';

const THEME_STYLE_ID = 'theme-vars';

export function resolveThemeValue(
  theme: Theme,
  id: ColorIdentifier,
  scheme: AppearanceScheme = resolveAppearanceScheme(),
): ColorValue | null {
  const override = theme.colors[id];
  // Other built-in palettes remain an explicit user choice. A local theme keeps
  // its own values and inherits the scheme only for roles it does not supply.
  const usesScheme = theme.id === 'cindy-light' || theme.id === 'cindy-dark' || isLocalThemeId(theme.id);
  if (usesScheme && !(isLocalThemeId(theme.id) && override !== undefined)) {
    const configured = scheme.desktop.colors[theme.type][id];
    if (configured !== undefined) return configured;
  }
  if (override !== undefined) {
    return override;
  }

  const currentDefault = colorRegistry.resolveDefault(id, theme.type);
  if (currentDefault !== null) {
    return currentDefault;
  }

  // The legacy CSS defined shared tokens in :root and only overrode the
  // tokens that changed in .dark. Preserve that exact cascade for root-only
  // tokens after moving to a single injected :root block.
  if (theme.type === 'dark') {
    return colorRegistry.resolveDefault(id, 'light');
  }

  return null;
}

/**
 * 把一个 theme 展开成"所有 colorRegistry 注册过的 token : 解析后值"的 JSON
 * colors map,用于"导出当前主题作为本地副本"功能。解析为 null 的 token 跳过。
 */
export function exportThemeColors(theme: Theme, scheme: AppearanceScheme = resolveAppearanceScheme()): Record<string, ColorValue> {
  const out: Record<string, ColorValue> = {};
  for (const contribution of colorRegistry.getColors()) {
    const value = resolveThemeValue(theme, contribution.id, scheme);
    if (value !== null) {
      out[contribution.id] = value;
    }
  }
  return out;
}

function serializeThemeCss(theme: Theme, scheme: AppearanceScheme): string {
  const declarations = Object.entries(exportThemeColors(theme, scheme))
    .map(([id, value]) => `--${id}:${value}`);
  const foundations = Object.entries(scheme.desktop.foundations)
    .filter(([id]) => !(isLocalThemeId(theme.id) && theme.colors[id] !== undefined))
    .map(([id, value]) => `--${id}:${value}`);
  return `:root{${declarations.join(';')};}` + (foundations.length ? `:root[data-appearance]{${foundations.join(';')};}` : '');
}

export class ThemeService {
  private readonly didChangeTheme = new Emitter<Theme>();
  private currentTheme: Theme | null = null;
  private currentScheme = resolveAppearanceScheme();

  applyTheme(theme: Theme, scheme: AppearanceScheme = resolveAppearanceScheme()): void {
    const style = this.getOrCreateThemeStyle();
    style.textContent = serializeThemeCss(theme, scheme);

    const root = document.documentElement;
    root.dataset.theme = theme.id;
    root.dataset.appearance = scheme.id;
    root.classList.toggle('dark', theme.type === 'dark');
    // Keep Chromium's native form controls (including number-input spinners)
    // on the same color scheme as the active application theme.
    root.style.colorScheme = theme.type;

    this.currentTheme = theme;
    this.currentScheme = scheme;
    this.didChangeTheme.fire(theme);
  }

  getColor(id: ColorIdentifier): ColorValue | null {
    if (this.currentTheme === null) {
      return null;
    }
    return resolveThemeValue(this.currentTheme, id, this.currentScheme);
  }

  /** 当前已激活的主题对象(尚未 applyTheme 时为 null)。供欢迎页读取 logo 初值。 */
  getCurrentTheme(): Theme | null {
    return this.currentTheme;
  }

  onDidChangeTheme(listener: (theme: Theme) => void): () => void {
    return this.didChangeTheme.event(listener);
  }

  private getOrCreateThemeStyle(): HTMLStyleElement {
    const existing = document.getElementById(THEME_STYLE_ID);
    if (existing instanceof HTMLStyleElement) {
      return existing;
    }

    const style = document.createElement('style');
    style.id = THEME_STYLE_ID;
    document.head.appendChild(style);
    return style;
  }
}

export const themeService = new ThemeService();
