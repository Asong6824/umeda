// @vitest-environment jsdom

import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ThemeBrandLockup } from '../ThemeBrandLockup';
import type { Theme } from '@/themes/types';
import minimalLight from '@/assets/umeda-wordmark-light.svg';
import minimalDark from '@/assets/umeda-wordmark-dark.svg';

afterEach(cleanup);

describe('ThemeBrandLockup', () => {
  // Unit: code-selected presets must change rendered artwork without changing the
  // theme or writing preferences. Existing tests only cover one custom theme.
  // Minimum input: a built-in theme with its own logo; minimal must suppress it.
  it.each(['light', 'dark'] as const)('renders the minimal code preset in %s and can return to original artwork', (type) => {
    const theme: Theme = { id: `cindy-${type}`, name: 'Built-in', type, colors: {}, brand: { logo: { src: 'original-logo.png' } } };
    const view = render(<ThemeBrandLockup theme={theme} schemeId="minimal" testId="brand" />);
    expect(view.queryByTestId('brand-icon')).toBeNull();
    expect(view.getByRole('img', { name: 'Umeda' }).getAttribute('src')).toBe(type === 'light' ? minimalLight : minimalDark);

    view.rerender(<ThemeBrandLockup theme={theme} schemeId="original" testId="brand" />);
    expect(view.getByTestId('brand-icon').querySelector('img')).not.toBeNull();
    expect(view.getByRole('img', { name: 'Umeda' }).getAttribute('src')).toBe('original-logo.png');
  });

  // Unit: configuration-and-overrides + design-governance compatibility. A local
  // home logo must still win; a broken override must fall back to the selected pack.
  it('preserves explicit local artwork and falls back to the minimal pack when it fails', () => {
    const theme: Theme = { id: 'custom-local', name: 'Local', type: 'dark', colors: {}, brand: {
      icon: { src: 'custom-icon.png' }, logo: { src: 'custom-logo.png' },
    } };
    const view = render(<ThemeBrandLockup theme={theme} schemeId="minimal" testId="brand" />);
    expect(view.getByRole('img', { name: 'Umeda' }).getAttribute('src')).toBe('custom-logo.png');
    fireEvent.error(view.getByRole('img', { name: 'Umeda' }));
    expect(view.getByRole('img', { name: 'Umeda' }).getAttribute('src')).toBe(minimalDark);
    fireEvent.error(view.getByTestId('brand-icon').querySelector('img')!);
    expect(view.queryByTestId('brand-icon')).toBeNull();
  });

  it('keeps the approved fixed slots and renders both custom assets', () => {
    const theme: Theme = {
      id: 'custom-local',
      name: 'Custom',
      type: 'light',
      colors: {},
      brand: {
        icon: { src: 'icon.png' },
        logo: { src: 'logo.png' },
      },
    };
    const view = render(<ThemeBrandLockup theme={theme} testId="brand" />);
    expect(view.getByTestId('brand').className).toContain('h-[50px]');
    expect(view.getByTestId('brand').className).toContain('gap-[9px]');
    expect(view.getByTestId('brand-icon').className).toContain('h-[50px]');
    expect(view.getByTestId('brand-icon').className).toContain('w-[50px]');
    expect(view.getByTestId('brand-icon').className).toContain('rounded-full');
    expect(view.getByTestId('brand-logo').className).toContain('h-[37.5px]');
    expect(view.getByTestId('brand-logo').className).toContain('w-[110px]');
    expect(view.getByTestId('brand-icon').querySelector('img')?.getAttribute('src')).toBe(
      'icon.png',
    );
    expect(view.getByTestId('brand-logo').querySelector('img')?.getAttribute('src')).toBe(
      'logo.png',
    );
  });

  it('uses alpha-visible bounds instead of transparent canvas dimensions', () => {
    const theme: Theme = {
      id: 'trimmed-local',
      name: 'Trimmed',
      type: 'light',
      colors: {},
      brand: {
        logo: {
          src: 'logo.png',
          visibleBounds: {
            x: 100,
            y: 100,
            width: 800,
            height: 200,
            sourceWidth: 1000,
            sourceHeight: 500,
          },
        },
      },
    };
    const view = render(<ThemeBrandLockup theme={theme} testId="brand" />);
    const image = view.getByTestId('brand-logo').querySelector('img') as HTMLImageElement;
    expect(image.style.width).toBe('137.5px');
    expect(image.style.height).toBe('68.75px');
    expect(Number.parseFloat(image.style.left)).toBeCloseTo(-13.75);
    expect(Number.parseFloat(image.style.top)).toBeCloseTo(-8.75);
  });

  it('retries a failed custom asset when refresh supplies a new object with the same src', () => {
    const makeTheme = (): Theme => ({
      id: 'retry-local',
      name: 'Retry',
      type: 'light',
      colors: {},
      brand: { icon: { src: 'same-icon.png' } },
    });
    const view = render(<ThemeBrandLockup theme={makeTheme()} testId="brand" />);
    const customImage = view.getByTestId('brand-icon').querySelector('img') as HTMLImageElement;

    fireEvent.error(customImage);
    expect(view.getByTestId('brand-icon').querySelector('img')?.getAttribute('src')).not.toBe(
      'same-icon.png',
    );

    view.rerender(<ThemeBrandLockup theme={makeTheme()} testId="brand" />);
    expect(view.getByTestId('brand-icon').querySelector('img')?.getAttribute('src')).toBe(
      'same-icon.png',
    );
  });
});
