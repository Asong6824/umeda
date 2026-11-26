/** Local UI QA only. Synthetic content and an in-memory production CloudVault. */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { samplePdf, sampleEpub } from './reader-fixtures';
import { fixture } from './fixture';
import { patchMarkdown, localDay } from '../src/documents';
import { validCardAiRequest } from '../src/cards/actions';
import { LibraryService } from '../src/library/service';
import { dispatchLibrary, runLibrary } from '../src/library/rpc';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist'), data = fixture();
await data.initialize();
const today = localDay(), half = `${today.slice(0, 4)}-H${Number(today.slice(5, 7)) <= 6 ? 1 : 2}`;
const documents = [
  ['30_目标/建立个人工作台.md', { type: 'goal', title: '建立个人工作台', period: half, status: 'active', allocation_weight: 50, created: today }, '# 建立个人工作台\n\n在不同设备上保持工作连续。'],
  ['31_项目/同步迁移.md', { type: 'project', title: '同步迁移', status: 'active', priority: 'P1', created: today, goals: ['[[30_目标/建立个人工作台]]'], result_metrics: [{ id: 'coverage', name: '同步覆盖率', unit: '%', baseline: 0, target: 100, current: 65 }] }, '# 同步迁移\n\n## 当前任务\n\n- [x] 建立同步层\n- [ ] 完成两端界面'],
  ['32_任务/检查离线内容.md', { type: 'task', title: '检查离线内容', status: 'todo', priority: 'P1', created: today, scheduled_for: today, scheduled_times: ['10:00'], projects: ['[[31_项目/同步迁移]]'] }, '# 检查离线内容\n\n先下载文档，再断开网络验证。'],
  ['32_任务/整理读书笔记.md', { type: 'task', title: '整理读书笔记', status: 'doing', priority: 'P2', created: today, scheduled_for: today, projects: [] }, '# 整理读书笔记\n\n保留来源和证据。'],
  ['11_原材料/阅读资料.md', { type: 'source', title: '阅读资料', format: 'article', status: 'captured', created: today }, '# 阅读资料\n\n这是一份可以离线查看和编辑的示例文档。\n\n## 重要观点\n\n知识来自持续阅读与实践。\n\n## 应用\n\n把理解写成行动。\n\n[[31_项目/同步迁移|查看相关项目]]'],
  ['22_知识/上下文连续性.md', { type: 'knowledge', title: '上下文连续性', status: 'draft', created: today }, '# 上下文连续性\n\n持久资料让不同执行入口共享长期信息。'],
  ['40_日记/今日记录.md', { type: 'diary', date: today, created: today, mood: 4, energy: 4 }, '# 今日记录\n\n完成了基础同步验证。'],
  ['10_收件箱/一个想法.md', {}, '# 一个想法\n\n先记录，再整理。'],
] as const;
for (const [name, metadata, body] of documents) await data.seed(name, Object.keys(metadata).length ? patchMarkdown('', metadata, body) : body);
await data.seed('11_原材料/Reading PDF.pdf', samplePdf());
await data.seed('11_原材料/Reading EPUB.epub', await sampleEpub());
await data.seed('11_原材料/搜索测试.md', '# 搜索测试\n\n' + '这是用于验证搜索覆盖范围的普通段落。\n'.repeat(700) + '\n超出摘要的全文验收标记。');
await data.seed('11_原材料/figure.svg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="360" height="100"><rect width="360" height="100" fill="#dde8df"/><text x="20" y="55" font-size="20">KOS attachment fixture</text></svg>'));
const source = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const library = new LibraryService(data.host); await library.initialize();
const runner = runLibrary(library, () => true); void runner.wake();
const previewHost = `window.__UMEDA_BOOT__={...window.__UMEDA_BOOT__,platform:'desktop',hostLibrary:true};window.__UMEDA_PREVIEW_HOST__={call:async(operation,payload)=>{const r=await fetch('/bridge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({operation,payload})});const j=await r.json();if(j.snapshot)window.dispatchEvent(new CustomEvent('umeda-library-state',{detail:j.snapshot}));if(j.error)throw Error(j.error);return j.result;}};`;
const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname === '/bridge' || pathname === '/__offline') {
      let body = ''; for await (const chunk of request) { body += chunk; if (body.length > 1024 * 1024) throw new Error('large'); }
      const payload = JSON.parse(body || '{}');
      if (pathname === '/__offline') { data.setOffline(payload.offline); response.end('{}'); return; }
      try {
        let result: unknown;
        if (payload.operation === 'cardAi') {
          if (!validCardAiRequest(payload.payload)) throw new Error('INVALID_CARD_AI_REQUEST');
          const action = payload.payload;
          const target = `cards/ai-${action.requestId}.md`;
          if (!library.files('notes').some(file => file.path === target)) await library.saveText('notes', target,
            patchMarkdown('', { type: 'card', card_id: `ai-${action.requestId}`, title: action.title, generated_by: 'ai' }, '这是合成预览结果，用于检查卡片保存与审核。'), 0);
          result = { disposition: 'submitted', taskId: `synthetic-${action.requestId}`, runId: `synthetic-${action.requestId}` };
        } else result = payload.operation === 'library' ? await dispatchLibrary(library, payload.payload) : await data.host.call(payload.operation, payload.payload); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ result, snapshot: library.getSnapshot() })); }
      catch (error) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'error' })); }
      return;
    }
    if (pathname === '/preview-host.js') { response.setHeader('content-type', 'text/javascript'); response.end(previewHost); return; }
    if (pathname === '/' || pathname === '/index.html') {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src blob:; frame-src 'self' blob:");
      response.end(source.replace('<script src="workbench.js">', '<script src="preview-host.js"></script><script src="workbench.js">')); return;
    }
    const type = ['/workbench.js', '/reader.js'].includes(pathname) ? 'text/javascript' : pathname === '/theme.css' ? 'text/css' : null;
    if (!type) { response.statusCode = 404; response.end(); return; }
    response.setHeader('content-type', type); response.end(await fs.readFile(path.join(root, pathname.slice(1))));
  } catch { response.statusCode = 500; response.end('failed'); }
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => console.log(JSON.stringify({ port: (server.address() as { port: number }).port })));
process.on('SIGTERM', () => { runner.stop(); server.close(() => process.exit(0)); });
