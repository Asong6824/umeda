import { isMap, parseDocument } from 'yaml';
import { parseKosObject } from './core/parse';
import type { KosObject } from './core/model';
import type { VaultSummary } from '@cindy/device-link';

export const EDIT_MAX_BYTES = 240 * 1024;
export function localDay(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function splitMarkdown(text: string) {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n(?:---|\.\.\.)(?:\r?\n|$))/.exec(text);
  return { frontmatter: match?.[2] ?? '', body: text.slice(match?.[0].length ?? 0), prefix: match?.[1] ?? '---\n', suffix: match?.[3] ?? '\n---\n' };
}
export function parseMetadata(text: string): Record<string, unknown> {
  if (!text.trim()) return {};
  const document = parseDocument(text, { uniqueKeys: true });
  if (document.errors.length) throw new Error('这份文档的属性格式有误，请在编辑器中检查后再保存。');
  const value: unknown = document.toJS({ maxAliasCount: 50 });
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('文档属性需要是键值表。');
  return value as Record<string, unknown>;
}
export function patchMarkdown(text: string, patch: Record<string, unknown>, body?: string): string {
  const parts = splitMarkdown(text), document = parseDocument(parts.frontmatter || '{}', { uniqueKeys: true });
  if (!parts.frontmatter && isMap(document.contents)) document.contents.flow = false;
  if (document.errors.length) throw new Error('文档属性格式有误，原文已保留。');
  for (const [key, value] of Object.entries(patch)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) throw new Error('无效的属性名称。');
    if (value === undefined) document.delete(key); else document.set(key, value);
  }
  const frontmatter = document.toString().trimEnd();
  return `${parts.prefix}${frontmatter}${parts.suffix}${body ?? parts.body}`;
}
export function summaryFromText(file: VaultSummary, text: string): VaultSummary {
  const { frontmatter, body } = splitMarkdown(text);
  return { ...file, indexError: undefined, frontmatter, excerpt: body.slice(0, 600) };
}
export function indexedObjects(files: VaultSummary[]): { objects: KosObject[]; issues: Array<{ path: string; message: string }> } {
  const objects: KosObject[] = [], issues: Array<{ path: string; message: string }> = [];
  for (const file of files) {
    if (file.deleted || !file.path.endsWith('.md') || file.path.startsWith('90_系统/')) continue;
    try {
      if (file.indexError) throw new Error(file.indexError === 'frontmatter-too-large' ? '文档属性超出看板索引范围，请打开原文查看。' : '未找到完整的文档属性，请打开原文检查。');
      const metadata = parseMetadata(file.frontmatter), object = parseKosObject(metadata, file.path);
      if (object) objects.push(object);
    } catch (error) { issues.push({ path: file.path, message: error instanceof Error ? error.message : '无法解析文档属性。' }); }
  }
  return { objects, issues };
}
export function displayTitle(file: VaultSummary): string {
  try { const title = parseMetadata(file.frontmatter).title; if (typeof title === 'string' && title.trim()) return title; } catch { /* Path remains usable. */ }
  const heading = /^#\s+(.+)$/m.exec(file.excerpt)?.[1];
  return heading ?? file.path.split('/').at(-1)!.replace(/\.md$/i, '');
}
/** Resolve wikilinks/relative links without admitting any path outside the selected Vault. */
export function resolveReference(reference: string, from: string, files: VaultSummary[]): VaultSummary | undefined {
  const clean = reference.replace(/^\[\[|\]\]$/g, '').split('|')[0].split('#')[0];
  let decoded: string;
  try { decoded = decodeURIComponent(clean); } catch { return; }
  if (!decoded || /^[a-z]+:|^\//i.test(decoded)) return;
  const parts = from.split('/').slice(0, -1);
  for (const part of decoded.split('/')) {
    if (part === '..') { if (!parts.length) return; parts.pop(); }
    else if (part && part !== '.') parts.push(part);
  }
  const candidates = [decoded, `${decoded}.md`, parts.join('/'), `${parts.join('/')}.md`];
  const exact = files.find(file => !file.deleted && candidates.includes(file.path));
  if (exact) return exact;
  const aliases = files.filter(file => !file.deleted && file.aliases?.some(path => candidates.includes(path)));
  if (aliases.length === 1) return aliases[0];
  const matches = files.filter(file => !file.deleted && file.path.split('/').at(-1)?.replace(/\.md$/i, '') === decoded.replace(/\.md$/i, ''));
  return matches.length === 1 ? matches[0] : undefined;
}
