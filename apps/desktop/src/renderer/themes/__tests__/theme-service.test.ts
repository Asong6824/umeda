// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';

import { defaultDark } from '../builtin/default-dark';
import { defaultLight } from '../builtin/default-light';
import { themeService } from '../theme-service';
import '../colors';
import { cindyLight } from '../builtin/cindy-light';
import { cindyDark } from '../builtin/cindy-dark';
import { resolveAppearanceScheme } from '@cindy/maker-shared/appearance-scheme';

describe('ThemeService native control color scheme', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-appearance');
    document.documentElement.classList.remove('dark');
    document.documentElement.style.removeProperty('color-scheme');
    document.getElementById('theme-vars')?.remove();
  });

  // Unit: appearance configuration must reach the public color service/CSS;
  // the previous suite only checked the native mode. Minimal input is one scheme
  // with a surface color and spacing, then a local theme overriding that role.
  it.each([cindyLight, cindyDark])('applies configured colors and foundations in $type without mutating the built-in theme', (theme) => {
    const original = { ...theme.colors };
    const scheme = resolveAppearanceScheme('minimal');
    themeService.applyTheme(theme, scheme);
    expect(themeService.getColor('surface')).toBe(scheme.desktop.colors[theme.type].surface);
    const css = document.getElementById('theme-vars')!.textContent!;
    expect(css).toContain(`--surface:${scheme.desktop.colors[theme.type].surface}`);
    expect(css).toContain(`--space-4:${scheme.desktop.foundations['space-4']}`);
    expect(theme.colors).toEqual(original);

    const local = { ...theme, id: 'test-local', colors: { surface: 'local-surface', radius: '8px' } };
    themeService.applyTheme(local, scheme);
    expect(themeService.getColor('surface')).toBe('local-surface');
    expect(document.getElementById('theme-vars')!.textContent).not.toContain(`--radius:${scheme.desktop.foundations.radius}`);
    themeService.applyTheme(theme, resolveAppearanceScheme('original'));
    expect(themeService.getColor('surface')).toBe(original.surface);
    expect(document.getElementById('theme-vars')!.textContent).not.toContain('--space-4:');
  });

  it('updates the native control color scheme when switching themes', () => {
    themeService.applyTheme(defaultDark);
    expect(document.documentElement.style.colorScheme).toBe('dark');

    themeService.applyTheme(defaultLight);
    expect(document.documentElement.style.colorScheme).toBe('light');
  });
});
