import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isVaultId, isVaultPath, VAULT_FILE_MAX_BYTES } from '@cindy/device-link';
import type { KnowledgeCallback, KnowledgeRequest } from '@cindy/mcps';
import { InvalidCardMetadataError, stampAgentCard } from '@cindy/kos-workbench/cards/provenance';
import { VaultFolder } from './disk';
import { managedVaultRoot, vaultReplicaRoot } from './managed';
import type { VaultConfiguration, VaultSyncConfiguration } from './service';

interface Access { userData: string; baseUrl: string; isCurrent(): boolean }
class KnowledgeError extends Error {}
const textPath = (relative: string) => /\.(?:md|markdown|txt)$/i.test(relative);
const validHash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const source = (vault: string, relative: string, hash: string) => ({ vault_id: vault, path: relative, hash });
function assertCurrent(access: Access) {
  if (!access.isCurrent()) throw new KnowledgeError('KNOWLEDGE_SCOPE_CHANGED');
}
function checkPath(relative: string) {
  if (!isVaultPath(relative)) throw new KnowledgeError('INVALID_KNOWLEDGE_PATH');
}
function decode(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new KnowledgeError('KNOWLEDGE_NOT_UTF8'); }
}

/** A resource adapter over the existing managed mirror, not another replica/outbox/index. */
export function createKnowledgeTools(getAccess: () => Access | null): KnowledgeCallback {
  return async (_context, request) => {
    let writeStarted = false;
    try {
      const access = getAccess();
      if (!access) throw new KnowledgeError('KNOWLEDGE_UNAVAILABLE');
      const config = JSON.parse(await fs.readFile(path.join(access.userData, 'vault-sync.json'), 'utf8')) as VaultSyncConfiguration;
      if (config.version !== 1 || !Array.isArray(config.vaults)
        || config.vaults.some(vault => !vault || !isVaultId(vault.id) || typeof vault.name !== 'string' || typeof vault.directory !== 'string')
        || new Set(config.vaults.map(vault => vault.id)).size !== config.vaults.length) throw new KnowledgeError('INVALID_VAULT_CONFIG');
      assertCurrent(access);
      // A route switch must never expose another route's mirror, or the pre-migration source.
      const vaults = config.vaults.filter(vault => vault.managed === true
        && path.resolve(vault.directory) === managedVaultRoot(access.userData, access.baseUrl, vault.id));
      if (request.operation === 'vaults') return { scope: 'local_mirror', vaults: vaults.map(({ id, name }) => ({ id, name })),
        unavailable_count: config.vaults.length - vaults.length, freshness: 'local_copy_not_cloud_verified' };
      const vault = vaults.find(item => item.id === request.vault_id);
      if (!vault) throw new KnowledgeError('KNOWLEDGE_VAULT_NOT_AVAILABLE');
      const disk = new VaultFolder(vault.directory, path.join(vaultReplicaRoot(access.userData, access.baseUrl, vault.id), 'history'));
      let result: Record<string, unknown>;
      if (request.operation === 'documents') result = await documents(access, vault, disk, request);
      else {
        checkPath(request.path);
        if (!textPath(request.path)) throw new KnowledgeError('KNOWLEDGE_UNSUPPORTED_FORMAT');
        if (request.operation === 'read') {
          const bytes = await disk.read(request.path), hash = disk.hash(bytes);
          if (request.expected_hash !== undefined && request.expected_hash !== hash) throw new KnowledgeError('KNOWLEDGE_CONFLICT');
          const text = decode(bytes), offset = request.offset ?? 0, limit = Math.min(request.limit ?? 16000, 32000);
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length || limit < 1) throw new KnowledgeError('INVALID_KNOWLEDGE_RANGE');
          result = { source: source(vault.id, request.path, hash), text: text.slice(offset, offset + limit), offset,
            total_chars: text.length, next_offset: offset + limit < text.length ? offset + limit : null };
        } else {
          if (request.expected_hash !== null && !validHash(request.expected_hash)) throw new KnowledgeError('INVALID_KNOWLEDGE_HASH');
          let previous: string | undefined;
          if (request.expected_hash !== null) {
            const current = await disk.read(request.path);
            if (disk.hash(current) !== request.expected_hash) throw new KnowledgeError('KNOWLEDGE_CONFLICT');
            previous = decode(current);
          }
          const bytes = new TextEncoder().encode(stampAgentCard(request.path, request.text, previous));
          if (bytes.length > VAULT_FILE_MAX_BYTES) throw new KnowledgeError('KNOWLEDGE_FILE_TOO_LARGE');
          assertCurrent(access);
          writeStarted = true;
          // Existing compare-and-replace retains displaced bytes and refuses stale writers.
          await disk.replace(request.path, bytes, request.expected_hash);
          result = { source: source(vault.id, request.path, disk.hash(bytes)), status: 'local_saved',
            sync_status: 'not_confirmed', history: request.expected_hash === null ? 'new_document' : 'previous_local_version_preserved' };
        }
      }
      assertCurrent(access);
      return { scope: 'local_mirror', freshness: 'local_copy_not_cloud_verified', ...result };
    } catch (error) {
      const nativeCode = (error as NodeJS.ErrnoException)?.code;
      const conflict = nativeCode === 'EEXIST' || (error instanceof Error && error.message === 'VAULT_LOCAL_CHANGED');
      const code = conflict ? 'KNOWLEDGE_CONFLICT' : error instanceof InvalidCardMetadataError ? 'INVALID_CARD_METADATA' : error instanceof KnowledgeError ? error.message
        : nativeCode === 'ENOENT' ? 'KNOWLEDGE_NOT_FOUND' : 'KNOWLEDGE_UNAVAILABLE';
      return { ok: false, errorCode: code, ...(writeStarted && !conflict ? { outcome: 'unknown' } : {}),
        hint: error instanceof InvalidCardMetadataError ? '卡片属性格式有误，原内容未改动。请修复 Markdown 顶部的 YAML 后再保存。'
          : conflict ? '内容已变化或创建目标已存在；先重读正文，再决定如何合并。'
          : writeStarted ? '写入结果未确认，先读取并核对哈希，禁止自动重复写入。' : '仅查询当前宿主托管的本机副本；检查资料库是否已初始化、路径、格式与同步状态。' };
    }
  };
}

async function documents(access: Access, vault: VaultConfiguration, disk: VaultFolder, request: Extract<KnowledgeRequest, { operation: 'documents' }>) {
  if (request.path_prefix) checkPath(request.path_prefix.replace(/\/$/, ''));
  if (request.after_path) checkPath(request.after_path);
  const paths = (await disk.listPaths()).filter(relative => (!request.path_prefix || relative.startsWith(request.path_prefix))
    && (!request.after_path || relative > request.after_path));
  const matches: Array<Record<string, unknown>> = [], skipped: Array<{ path: string; reason: string }> = [];
  const query = request.query?.trim().toLowerCase(), limit = Math.min(request.limit ?? 40, 100);
  let after: string | null = null, excluded = 0, skippedCount = 0, resultBytes = 0;
  for (let index = 0; index < paths.length; index++) {
    assertCurrent(access);
    const relative = paths[index];
    let match: Record<string, unknown> | undefined;
    if (!query) match = { path: relative, format: textPath(relative) ? 'text' : 'attachment' };
    else if (!textPath(relative)) excluded++;
    else {
      try {
        const bytes = await disk.read(relative), text = decode(bytes), position = text.toLowerCase().indexOf(query);
        if (position >= 0 || relative.toLowerCase().includes(query)) match = { source: source(vault.id, relative, disk.hash(bytes)),
          excerpt: text.slice(Math.max(0, position - 80), Math.max(0, position - 80) + 320) };
      } catch { skippedCount++; if (skipped.length < 20) skipped.push({ path: relative, reason: 'unreadable_or_changed' }); }
    }
    if (match) {
      const bytes = Buffer.byteLength(JSON.stringify(match));
      // Bound serialized payload, not the size of the knowledge resource. Resume before this match.
      if (matches.length && resultBytes + bytes > 64000) { after = paths[index - 1]; break; }
      matches.push(match); resultBytes += bytes;
    }
    if (matches.length >= limit) { after = index + 1 < paths.length ? relative : null; break; }
  }
  return { documents: matches, next_after_path: after, partial: skippedCount > 0 || excluded > 0, skipped, skipped_count: skippedCount,
    excluded_attachments: excluded, coverage: query ? 'local_markdown_and_text' : 'local_paths' };
}
