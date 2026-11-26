import assert from 'node:assert/strict';
export default {
  name: 'umeda-work',
  entry: './fixture.tsx',
  viewport: { width: 1180, height: 800 },
  real: 'WorkPage, standard form controls, live invalidation handling, translations and both themes',
  notCovered: 'SQLite, IPC trust, real Agent calls, old KOS migration and cross-device sync; storage/IPC are covered separately',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useAuth=()=>({dataOwnerId:"work-fixture",dataOwnerGeneration:1});',
    'src/renderer/lib/toast': 'export const toast={error:()=>{}};',
  },
  cases: {
    conflict: { about: 'Saved local and shared versions, explicit conflict resolution' },
    default: { about: 'To-dos, project and goal details with progress editing' },
    empty: { about: 'Title-only creation without a forced goal/project hierarchy' },
    long: { about: 'Long task titles wrap without hiding actions' },
    imported: { about: 'Imported Markdown, hidden metadata, record details and related-object navigation' },
  },
  async ready(page) { await page.getByRole('button', { name: /./ }).first().waitFor(); },
  async check(page, ui) {
    const label = key => ui.t(`umedaWork.${key}`);
    if (ui.case === 'conflict') {
      await page.getByText('Offline progress update', { exact: true }).click();
      await page.getByText('Local draft', { exact: true }).waitFor();
      await page.getByText('Shared update', { exact: true }).waitFor();
      await ui.capture('sync-conflict');
      await page.getByRole('button', { name: await label('sync.useRemote'), exact: true }).click();
      await page.getByText(await label('sync.saved'), { exact: true }).waitFor();
      await ui.capture('sync-resolved');
    }
    if (ui.case !== 'empty') {
      await page.getByRole('radio', { name: await label('tabs.goal'), exact: true }).click();
      await page.getByRole('button', { name: /Build durable habits/ }).click();
      await page.getByRole('heading', { name: 'Build durable habits' }).waitFor();
      await ui.capture('goal');
      if (ui.case === 'imported') {
        await page.getByRole('heading', { name: 'Outcomes' }).waitFor();
        assert.equal(await page.getByText(/allocation_weight/).count(), 0);
        await page.getByRole('button', { name: 'Reader delivered' }).click();
        const history = page.getByRole('dialog');
        await history.getByText('Readback matched').waitFor();
        await ui.capture('record-details');
        await history.getByRole('button', { name: 'Reading companion' }).click();
        await page.getByRole('heading', { name: 'Reading companion' }).waitFor();
        await ui.capture('related-project');
        await page.getByRole('radio', { name: await label('tabs.goal'), exact: true }).click();
        await page.getByRole('button', { name: /Build durable habits/ }).click();
      }
      await page.getByRole('button', { name: await label('edit'), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(await label('progress'), { exact: true }).fill('40');
      await dialog.getByLabel(await label('note'), { exact: true }).fill('A second milestone completed with evidence.');
      await ui.capture('progress-form');
      await dialog.getByRole('button', { name: await label('save'), exact: true }).click();
      await dialog.waitFor({ state: 'hidden' });
      await page.getByText('A second milestone completed with evidence.').first().waitFor();
      assert.equal(await page.getByRole('progressbar').getAttribute('value'), '40');
      await ui.capture('progress-saved');
    } else {
      await page.getByRole('button', { name: await ui.t('umedaWork.newItem', { kind: await label('kind.task') }), exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel(await label('name'), { exact: true }).fill('One small thing');
      await ui.capture('title-only');
      await dialog.getByRole('button', { name: await label('save'), exact: true }).click();
      await page.getByRole('heading', { name: 'One small thing' }).waitFor();
    }
  },
};
