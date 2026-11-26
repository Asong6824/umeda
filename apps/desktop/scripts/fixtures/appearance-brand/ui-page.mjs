import assert from 'node:assert/strict';

export default {
  name: 'appearance-brand',
  entry: './fixture.tsx',
  viewport: { width: 800, height: 600 },
  real: 'ThemeBrandLockup, BrandLoadingMark/useBrandLogo, code-selected asset packs, theme service and semantic colors',
  notCovered: 'Full new-task route, local-theme failure recovery, share export, loading animation timing/reduced-motion, mobile/native startup, system icons and other avatars',
  cases: {
    default: { about: 'Original artwork retained by the code-selected preset', data: { schemeId: 'original' } },
    minimal: { about: 'Minimal Umeda wordmark without the character icon', data: { schemeId: 'minimal' } },
    editorial: { about: 'Warm editorial paper palette shared with the personal site', data: { schemeId: 'editorial' } },
    loading: { about: 'Real loading wordmark consumes the active code preset', data: { loading: true } },
  },
  async check(page, ui) {
    const root = ui.data.loading ? page.getByRole('status') : page.getByTestId('appearance-brand');
    if (ui.data.loading) {
      await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.brand-loading-mark')).opacity) > 0.9);
    }
    const images = root.locator('img');
    assert.equal(await images.count(), ui.data.loading || ui.data.schemeId === 'minimal' ? 1 : 2);
    for (const image of await images.all()) {
      assert.ok(await image.evaluate((el) => el.complete && el.naturalWidth > 0), 'brand asset must decode');
    }
  },
};
