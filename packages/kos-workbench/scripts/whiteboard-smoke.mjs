/** E2E: real LibraryClient -> host service -> synthetic CloudVault, isolated Electron profile.
 * Covers cross-board reuse, persisted layout, content review, and source excerpt navigation.
 * No personal vault, account, or running Cindy instance is touched.
 */
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(path.join(repo, 'apps/desktop/package.json'));
const origin = process.env.KOS_QA_ORIGIN ?? 'http://127.0.0.1:55483';
const output = await fs.mkdtemp(path.join(os.tmpdir(), 'kos-whiteboard-qa-'));
const main = path.join(output, 'main.cjs');
await fs.writeFile(main, `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(output, 'profile'))});app.whenReady().then(()=>{new BrowserWindow({width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}}).loadURL(${JSON.stringify(origin)});});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
const app = await require('playwright-core')._electron.launch({ executablePath: require('electron'), args: [main], env });
try {
  const page = await app.firstWindow(), errors = [];
  const stamp = Date.now(), cardTitle = `共享思考卡片 ${stamp}`, firstBoard = `KOS 模型优化 ${stamp}`;
  page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { window.__UMEDA_BOOT__ = { platform: 'desktop', theme: 'light', locale: 'zh-CN' }; });
  await page.reload();
  const nav = name => page.locator('.knowledge-sidebar nav').getByRole('button', { name, exact: true });
  const newBoard = async title => {
    await page.getByRole('button', { name: '新建白板', exact: true }).first().click();
    await page.getByLabel('白板名称', { exact: true }).fill(title);
    await page.locator('.whiteboard-directory form').getByRole('button', { name: '保存', exact: true }).click();
    await page.locator('.whiteboard-tools').getByText(title, { exact: true }).waitFor();
  };
  await newBoard(firstBoard);
  await page.locator('.card-shelf').getByRole('button', { name: '新建卡片' }).click();
  await page.locator('.quick-note').getByLabel('标题', { exact: true }).fill(cardTitle);
  await page.locator('.quick-note').getByLabel('内容', { exact: true }).fill('同一想法可以出现在不同思考场景中。');
  await page.locator('.quick-note').getByRole('button', { name: '保存', exact: true }).click();
  const node = page.locator('.react-flow__node').filter({ hasText: cardTitle });
  await node.waitFor();
  await page.getByRole('button', { name: '添加文字', exact: true }).click();
  await page.getByLabel('写下想法', { exact: true }).fill('为什么要保留思考上下文？');
  await page.getByRole('button', { name: '添加分区', exact: true }).click();
  await page.getByLabel('分区名称', { exact: true }).fill('候选方案');
  const section = page.locator('.react-flow__node').filter({ has: page.locator('.knowledge-node.section') });
  const groupBefore = await section.boundingBox(), cardBefore = await node.boundingBox();
  assert.ok(groupBefore && cardBefore);
  await page.mouse.move(groupBefore.x + 12, groupBefore.y + groupBefore.height / 2);
  await page.mouse.down(); await page.mouse.move(groupBefore.x + 72, groupBefore.y + groupBefore.height / 2 + 30, { steps: 12 }); await page.mouse.up();
  const groupAfter = await section.boundingBox(), cardAfter = await node.boundingBox();
  assert.ok(groupAfter && cardAfter && Math.abs(cardAfter.x - cardBefore.x) > 10);
  assert.ok(Math.abs((groupAfter.x - groupBefore.x) - (cardAfter.x - cardBefore.x)) < 2);
  const sourceHandle = await node.locator('.react-flow__handle-right').boundingBox();
  const targetHandle = await page.locator('.react-flow__node').filter({ has: page.getByLabel('写下想法', { exact: true }) }).locator('.react-flow__handle-left').boundingBox();
  assert.ok(sourceHandle && targetHandle);
  await page.mouse.move(sourceHandle.x + sourceHandle.width / 2, sourceHandle.y + sourceHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetHandle.x + targetHandle.width / 2, targetHandle.y + targetHandle.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.locator('.react-flow__edge').waitFor({ state: 'attached' });
  const edgePath = await page.locator('.react-flow__edge-path').getAttribute('d');
  assert.ok(edgePath && !edgePath.includes('NaN'));
  await page.locator('.whiteboard-tools').getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.whiteboard-tools').getByText('白板已保存在本机', { exact: true }).waitFor();
  await page.locator('.card-shelf article').filter({ hasText: 'Reading PDF.pdf' }).getByRole('button', { name: '放到白板' }).click();
  await page.locator('.card-rich-preview canvas[data-preview-ready="true"]').waitFor();
  await page.locator('.card-shelf article').filter({ hasText: 'figure.svg' }).getByRole('button', { name: '放到白板' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.card-rich-preview img')].some(image => image.naturalWidth > 0));
  await node.locator('header strong').click();
  await page.getByRole('button', { name: 'AI 总结', exact: true }).click();
  const aiResultNode = page.locator('.react-flow__node').filter({ hasText: 'AI 总结' });
  await aiResultNode.getByRole('button', { name: '打开', exact: true }).click();
  await page.getByRole('button', { name: '认可这份内容', exact: true }).click();
  await page.locator('.card-review-strip').waitFor({ state: 'hidden' });
  await page.locator('.knowledge-reader').getByRole('button', { name: '关闭', exact: true }).click();
  const proposeRevision = async () => {
    await page.locator('.knowledge-sidebar footer').getByRole('button', { name: '同步', exact: true }).click();
    await page.evaluate(async boardTitle => {
      const host = window.__UMEDA_PREVIEW_HOST__, snapshot = await host.call('library', { command: 'snapshot' });
      const file = snapshot.catalog.files.notes.find(file => file.path.startsWith('cards/ai-') && file.frontmatter?.includes('title: AI 总结') && file.frontmatter.includes(boardTitle));
      const text = await host.call('library', { command: 'readText', args: { vaultId: 'notes', file } });
      const prefix = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)[0];
      await host.call('library', { command: 'saveText', args: { vaultId: 'notes', path: file.path, baseRevision: file.revision, text: prefix + 'AI 提议的新结论' } });
    }, firstBoard);
    await aiResultNode.getByRole('button', { name: '打开', exact: true }).click();
    await page.getByRole('button', { name: '查看改动', exact: true }).click();
    assert.match(await page.getByLabel('已认可内容', { exact: true }).inputValue(), /合成预览结果/);
    assert.equal(await page.getByLabel('AI 修改稿', { exact: true }).inputValue(), 'AI 提议的新结论');
  };
  await proposeRevision();
  await page.getByRole('button', { name: '保留原稿', exact: true }).click();
  await page.locator('.card-review-strip').waitFor({ state: 'hidden' });
  await page.locator('.knowledge-reader').getByRole('button', { name: '关闭', exact: true }).click();
  await proposeRevision();
  await page.getByRole('button', { name: '接受修改', exact: true }).click();
  await page.locator('.card-review-strip').waitFor({ state: 'hidden' });
  await page.locator('.knowledge-reader .markdown-content').getByText('AI 提议的新结论', { exact: true }).waitFor();
  // Regression: an explicit owner edit must display the newly saved prose and
  // must not ask the owner to review their own edit or fall back to the old snapshot.
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('.body-editor').fill('主人亲自修订的结论');
  await page.locator('.knowledge-reader').getByRole('button', { name: '保存', exact: true }).click();
  await page.locator('.knowledge-reader .markdown-content').getByText('主人亲自修订的结论', { exact: true }).waitFor();
  await page.locator('.card-review-strip').waitFor({ state: 'hidden' });
  await page.locator('.knowledge-reader').getByRole('button', { name: '关闭', exact: true }).click();
  await page.screenshot({ path: path.join(output, 'desktop-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(output, 'desktop-dark.png') });
  await page.reload();
  await page.getByLabel('写下想法', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('写下想法', { exact: true }).inputValue(), '为什么要保留思考上下文？');
  // Sequential device use: another replica updates the layout, then this open page
  // refreshes. This is device handoff, not simultaneous collaborative editing.
  await page.locator('.knowledge-sidebar footer').getByRole('button', { name: '同步', exact: true }).click();
  const remote = await page.evaluate(async title => {
    const host = window.__UMEDA_PREVIEW_HOST__;
    const snapshot = await host.call('library', { command: 'snapshot' });
    const file = snapshot.catalog.files.notes.find(file => file.frontmatter?.includes(title));
    const text = await host.call('library', { command: 'readText', args: { vaultId: 'notes', file } });
    return { file, text };
  }, firstBoard);
  const prefix = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(remote.text)[0];
  const layout = JSON.parse(remote.text.slice(prefix.length));
  layout.items.push({ id: `other-device-${stamp}`, kind: 'text', x: 600, y: 500, width: 280, height: 160, text: '来自另一设备的思考' });
  const update = await page.request.post(origin + '/bridge', { data: { operation: 'http', payload: { path: '/api/vaults/notes/file?path=' + encodeURIComponent(remote.file.path), method: 'PUT', headers: { 'x-vault-base-revision': String(remote.file.revision) }, body: prefix + JSON.stringify(layout) } } });
  assert.equal((await update.json()).result.status, 200);
  await page.locator('.knowledge-sidebar footer').getByRole('button', { name: '同步', exact: true }).click();
  await page.locator('.knowledge-node textarea').filter({ hasText: '来自另一设备的思考' }).waitFor();
  await newBoard('跨场景复用');
  await page.locator('.card-shelf article').filter({ hasText: cardTitle }).getByRole('button', { name: '放到白板' }).click();
  await node.waitFor();
  await node.getByRole('button', { name: '打开', exact: true }).click();
  await page.locator('.knowledge-reader .markdown-content').getByText('同一想法可以出现在不同思考场景中。', { exact: true }).waitFor();
  await page.getByText('出现在这些白板', { exact: true }).click();
  await page.locator('.card-locations').getByRole('button', { name: firstBoard, exact: true }).waitFor();
  await page.locator('.knowledge-reader').getByRole('button', { name: '关闭', exact: true }).click();
  await node.click();
  await page.getByRole('button', { name: '移出白板', exact: true }).click();
  assert.equal(await node.count(), 0);
  await nav('卡片库').click();
  assert.equal(await page.locator('.knowledge-card-open').filter({ hasText: cardTitle }).count(), 1);
  // Explicit AI provenance enters the human review path; movement alone never does.
  const aiTitle = `AI 研究草稿 ${stamp}`;
  const aiPath = `cards/qa-ai-${stamp}.md`;
  await page.request.post(origin + '/bridge', { data: { operation: 'library', payload: { command: 'saveText', args: { vaultId: 'notes', path: aiPath, baseRevision: 0, text: `---\ntype: card\ncard_id: qa-ai-${stamp}\ntitle: ${aiTitle}\ngenerated_by: ai\n---\n需要人判断的研究结论。` } } } });
  await nav('待审核').click();
  // Refresh the view receipt, as an Agent write can arrive independently of this tab.
  await page.locator('.knowledge-sidebar footer').getByRole('button', { name: '同步', exact: true }).click();
  await page.locator('.knowledge-card-open').filter({ hasText: aiTitle }).click();
  await page.getByRole('button', { name: '认可这份内容', exact: true }).click();
  await page.locator('.card-review-strip').waitFor({ state: 'hidden' });
  await page.locator('.knowledge-reader').getByRole('button', { name: '关闭', exact: true }).click();
  await nav('卡片库').click();
  await page.locator('.knowledge-card-open').filter({ hasText: '阅读资料' }).first().click();
  await page.locator('.markdown-content p').filter({ hasText: '知识来自持续阅读与实践。' }).evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '保存为摘录卡', exact: true }).click();
  await page.locator('.knowledge-reader').getByRole('button', { name: '关闭', exact: true }).click();
  const excerpt = page.locator('.knowledge-card-list article').filter({ has: page.getByText('摘录', { exact: true }) }).filter({ hasText: '阅读资料' }).first();
  await excerpt.locator('.knowledge-card-open').click();
  await page.locator('.source-location').click();
  await page.locator('.knowledge-reader .markdown-content').getByText('知识来自持续阅读与实践。', { exact: true }).waitFor();
  await page.locator('.knowledge-reader').getByRole('button', { name: '关闭', exact: true }).click();
  await nav('白板').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile-light.png') });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.screenshot({ path: path.join(output, 'mobile-dark.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, output }));
} catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, 'failure.png') }); await fs.writeFile(path.join(output, 'failure.html'), await page.content()); console.error(output, await page.locator('.knowledge-reader .markdown-content p').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, rect: node.getBoundingClientRect().toJSON(), visibility: getComputedStyle(node).visibility })))); throw error; } finally { await app.close(); }
