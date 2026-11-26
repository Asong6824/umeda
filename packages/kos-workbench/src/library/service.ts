import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  isVaultId,
  isVaultPath,
  type VaultInfo,
  type VaultSummary,
  type VaultFile,
} from '@cindy/device-link';
import { EDIT_MAX_BYTES, summaryFromText, localDay } from '../documents';
import { uniqueId, type HttpReply, type WorkbenchHost } from './ports';
import { mergeReadingStates } from '../reader/state';

import { filesFromSnapshot, type PendingEdit, type PendingMove, type StorageReport, type BookTextPart, type BookIndex, type Catalog, type WorkbenchSnapshot, type OfflineFile, type SearchResults } from './model';
import { encodeText, fromBase64 } from './encoding';
export { encodeText, fromBase64 } from './encoding';
export type { WorkbenchSnapshot } from './model';
const emptyCatalog = (): Catalog => ({ vaults: [], files: Object.create(null), cursors: Object.create(null), updatedAt: 0 });
const digest = (bytes: Uint8Array) => bytesToHex(sha256(bytes));
const textFile = (path: string) => /\.(md|txt|json|ya?ml|csv)$/i.test(path);
const monotonicNow = () => globalThis.performance?.now?.() ?? Date.now();
function safeKey(value: string) {
  return encodeURIComponent(value);
}

/** Durable human document edits. A cloud receipt and a local queue entry are different states. */
export class LibraryService {
  private snapshot: WorkbenchSnapshot = {
    serviceId: uniqueId(),
    catalog: emptyCatalog(),
    pending: [],
    loading: true,
    offline: false,
    error: null,
    conflicts: [],
    progress: 0,
  };
  private listeners = new Set<() => void>();
  private namespace = '';
  private saves: Promise<unknown> = Promise.resolve();
  private mutations: Promise<unknown> = Promise.resolve();
  private refreshPromise: Promise<void> | null = null;
  private refreshAgain = false;
  private liveStops = new Set<() => void>();
  private sending: string | null = null;
  private disposed = false;
  private initialized = false;
  private localReadyPromise: Promise<void> | null = null;
  private initializePromise: Promise<void> | null = null;
  private atomic = false;
  private contentSearch = false;
  private hasStorageReport = false;
  private moving: string | null = null;
  private bookIndexes: Record<string, BookIndex> = {};
  private bookSummary() { return Object.fromEntries(Object.entries(this.bookIndexes).map(([key, index]) => [key, { count: index.parts.length, complete: index.complete, bytes: index.bytes }])); }
  private downloading: Promise<void> | null = null;
  private timings = new Map<string, number[]>();
  private observe(name: string, start: number) {
    const samples = [...(this.timings.get(name) ?? []), Math.max(0, monotonicNow() - start)];
    this.timings.set(name, samples.slice(-32));
  }
  diagnostics() {
    return Object.fromEntries([...this.timings].map(([name, samples]) => { const sorted = [...samples].sort((a, b) => a - b); return [name, { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }]; }));
  }
  constructor(readonly host: WorkbenchHost) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish(patch: Partial<WorkbenchSnapshot>) {
    if (this.disposed) return;
    if (
      Object.entries(patch).every(([key, value]) =>
        Object.is(this.snapshot[key as keyof WorkbenchSnapshot], value),
      )
    )
      return;
    this.snapshot = { ...this.snapshot, ...patch, sequence: (this.snapshot.sequence ?? 0) + 1 };
    for (const listener of this.listeners) listener();
  }
  private async get<T>(key: string, fallback: T, strict = false): Promise<T> {
    const raw = await this.host.call<string | null>('get', { key: this.namespace + key });
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      if (strict) throw new Error('本机草稿格式有误，已保留原记录。');
      return fallback;
    }
  }
  private set(key: string, value: unknown): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('LIBRARY_STOPPED'));
    const raw = JSON.stringify(value);
    return this.host.call('set', { key: this.namespace + key, value: raw });
  }
  private persist(catalog = true, pending = true, state = this.snapshot, moves = pending): Promise<unknown> {
    this.saves = this.saves
      .catch(() => undefined)
      .then(async () => {
        if (this.disposed) throw new Error('LIBRARY_STOPPED');
        if (this.atomic) {
          const entries = [
            ...(moves ? [{ key: this.namespace + 'moves', value: JSON.stringify(state.moves ?? []) }] : []),
            ...(catalog ? [{ key: this.namespace + 'catalog', value: JSON.stringify(state.catalog) }] : []),
            ...(pending ? [{ key: this.namespace + 'pending', value: JSON.stringify(state.pending) }] : []),
          ];
          await this.host.call('commit', { entries });
          return;
        }
        if (catalog) await this.set('catalog', state.catalog);
        if (pending) await this.set('pending', state.pending);
        if (moves) await this.set('moves', state.moves ?? []);
      });
    return this.saves;
  }
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const next = this.mutations.catch(() => undefined).then(() => {
      if (this.disposed) throw new Error('LIBRARY_STOPPED');
      return run();
    });
    this.mutations = next;
    return next;
  }
  initialize(): Promise<void> {
    this.initializePromise ??= this.ready().then(() => this.refresh()).catch(error => { this.initializePromise = null; throw error; });
    return this.initializePromise;
  }
  /** Only local scope and durable edits are needed to read/edit; the network is separate. */
  ready(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('LIBRARY_STOPPED'));
    this.localReadyPromise ??= this.initializeNow().catch(error => {
      this.localReadyPromise = null;
      this.publish({ loading: false, offline: true, error: '本机资料暂时无法读取，已有内容未被替换。' });
      throw error;
    });
    return this.localReadyPromise;
  }
  private async initializeNow(): Promise<void> {
    const started = monotonicNow();
    const info = await this.host.call<{ namespace: string; atomic?: boolean; contentSearch?: boolean; storageReport?: boolean }>('info');
    this.namespace = `${info.namespace}:`;
    this.atomic = info.atomic === true;
    this.contentSearch = info.contentSearch === true;
    this.hasStorageReport = info.storageReport === true;
    const [catalog, pending] = await Promise.all([
      this.get('catalog', emptyCatalog()),
      this.get<PendingEdit[]>('pending', [], true),
    ]);
    if (
      !Array.isArray(pending) ||
      pending.some(
        (edit) =>
          !isVaultId(edit.vaultId) || !isVaultPath(edit.path) || typeof edit.text !== 'string',
      )
    )
      throw new Error('本机草稿格式有误，已保留原记录。');
    const downloads = await this.get<OfflineFile[]>('offline-files', [], true);
    if (!Array.isArray(downloads) || downloads.some(item => !isVaultId(item.vaultId) || !isVaultPath(item.path) || !['pending', 'ready', 'error'].includes(item.status))) throw new Error('INVALID_OFFLINE_FILES');
    const moves = await this.get<PendingMove[]>('moves', [], true);
    if (!Array.isArray(moves) || moves.some(move => !isVaultId(move.vaultId) || !isVaultPath(move.from) || !isVaultPath(move.to) || typeof move.id !== 'string' || !move.id || typeof move.documentId !== 'string' || !move.documentId || !Number.isSafeInteger(move.baseRevision) || move.baseRevision < 1 || !move.file || move.file.documentId !== move.documentId || !['pending', 'conflict'].includes(move.status))) throw new Error('INVALID_LIBRARY_MOVES');
    const bookIndexes = await this.get<Record<string, BookIndex>>('book-indexes', {}, true);
    if (!bookIndexes || typeof bookIndexes !== 'object' || Array.isArray(bookIndexes) || Object.values(bookIndexes).some(index => !index || !Array.isArray(index.parts) || typeof index.complete !== 'boolean' || !Number.isSafeInteger(index.bytes) || index.bytes < 0)) throw new Error('INVALID_BOOK_INDEX');
    this.bookIndexes = bookIndexes;
    this.publish({ catalog, pending, downloads, moves, bookIndexes: this.bookSummary(), loading: !catalog.vaults.length });
    this.initialized = true;
    this.observe('localReady', started);
  }
  async http<T>(
    path: string,
    method = 'GET',
    body?: string,
    headers?: Record<string, string>,
  ): Promise<T> {
    if (this.disposed) throw new Error('工作台已关闭。');
    const reply = await this.host.call<HttpReply>('http', { path, method, body, headers });
    if (reply.status < 200 || reply.status >= 300)
      throw Object.assign(
        new Error(
          reply.status === 409
            ? '这份文档已在其他设备修改。'
            : `服务暂时不可用（${reply.status}）。`,
        ),
        { status: reply.status },
      );
    return JSON.parse(reply.body) as T;
  }
  refresh(notified = false): Promise<void> {
    if (this.disposed || !this.initialized) return Promise.resolve();
    if (this.refreshPromise) {
      if (notified) this.refreshAgain = true;
      return this.refreshPromise;
    }
    this.refreshPromise = (async () => {
      do {
        this.refreshAgain = false;
        await this.refreshNow();
      } while (this.refreshAgain && !this.disposed);
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }
  private async refreshNow(): Promise<void> {
    const started = monotonicNow();
    try {
      await this.flush();
      await this.flushMoves();
      let { vaults, features = [] } = await this.http<{ vaults: VaultInfo[]; features?: string[] }>('/api/vaults');
      if (
        !Array.isArray(vaults) ||
        vaults.some((vault) => !isVaultId(vault.id) || typeof vault.name !== 'string')
      )
        throw new Error('资料库目录格式有误。');
      if (!vaults.length) {
        const created = await this.http<VaultInfo>('/api/vaults/umeda-default', 'PUT', JSON.stringify({ name: 'Umeda' }), { 'content-type': 'application/json' });
        if (!created || !isVaultId(created.id) || typeof created.name !== 'string') throw new Error('资料库目录格式有误。');
        vaults = [created];
      }
      let catalog = this.snapshot.catalog;
      if (features.includes('vault-library-v1') && catalog.identityVersion !== 2) {
        // Re-read metadata once so unchanged legacy documents also acquire their stable identity.
        catalog = { ...catalog, identityVersion: 2, capabilities: features, cursors: {}, trash: {} };
        this.publish({ catalog });
        await this.persist(true, false);
      }
      if (JSON.stringify(vaults) !== JSON.stringify(catalog.vaults)) {
        catalog = { ...catalog, vaults };
        this.publish({ catalog });
        await this.persist(true, false);
      }
      for (const vault of vaults) {
        const previous = Object.hasOwn(catalog.files, vault.id) ? catalog.files[vault.id] : [];
        const files = new Map(previous.map((file) => [file.path, file]));
        const deleted = new Map((Object.hasOwn(catalog.trash ?? {}, vault.id) ? catalog.trash![vault.id] : []).map(file => [file.path, file]));
        let after = Object.hasOwn(catalog.cursors, vault.id) ? catalog.cursors[vault.id] : 0,
          more: boolean;
        do {
          const page = await this.http<{ files: VaultSummary[]; cursor: number; more: boolean }>(
            `/api/vaults/${vault.id}/index?after=${after}&maxBytes=524288`,
          );
          if (
            !Array.isArray(page.files) ||
            !Number.isSafeInteger(page.cursor) ||
            page.cursor < after ||
            (page.more && page.cursor <= after)
          )
            throw new Error('资料库索引格式有误。');
          let changed = !Object.hasOwn(catalog.files, vault.id) || page.cursor !== after;
          for (const file of page.files) {
            if (
              !isVaultPath(file.path) ||
              !Number.isSafeInteger(file.revision) ||
              typeof file.frontmatter !== 'string' ||
              typeof file.excerpt !== 'string'
            )
              throw new Error('资料库索引格式有误。');
            if (file.deleted) {
              changed = files.delete(file.path) || changed;
              if (file.movedTo) deleted.delete(file.path); else deleted.set(file.path, file);
            } else if (JSON.stringify(files.get(file.path)) !== JSON.stringify(file)) {
              deleted.delete(file.path);
              files.set(file.path, file);
              changed = true;
            }
          }
          after = page.cursor;
          more = page.more;
          if (changed) {
            const nextFiles = { ...catalog.files },
              cursors = { ...catalog.cursors }, trash = { ...catalog.trash };
            Object.defineProperty(trash, vault.id, { value: [...deleted.values()], writable: true, enumerable: true, configurable: true });
            Object.defineProperty(nextFiles, vault.id, {
              value: [...files.values()],
              writable: true,
              enumerable: true,
              configurable: true,
            });
            Object.defineProperty(cursors, vault.id, {
              value: after,
              writable: true,
              enumerable: true,
              configurable: true,
            });
            catalog = { ...catalog, files: nextFiles, cursors, trash, updatedAt: Date.now() };
            this.publish({ catalog, progress: files.size });
            await this.persist(true, false);
          }
        } while (more && !this.disposed);
      }
      this.publish({ offline: false, error: null, loading: false });
    } catch (error) {
      this.publish({
        offline: true,
        loading: false,
        error: error instanceof Error ? error.message : '暂时无法同步，已保存的内容仍可使用。',
      });
    } finally { this.observe('refresh', started); }
  }
  files(vaultId: string): VaultSummary[] { return filesFromSnapshot(this.snapshot, vaultId); }
  private sourcePath(vaultId: string, path: string): string {
    return this.snapshot.moves?.find(move => move.vaultId === vaultId && move.to === path && move.status === 'pending')?.from ?? path;
  }
  async readText(vaultId: string, file: VaultSummary): Promise<string> {
    const started = monotonicNow();
    try { return await this.readTextNow(vaultId, file); }
    finally { this.observe('textRead', started); }
  }
  private async readTextNow(vaultId: string, file: VaultSummary): Promise<string> {
    await this.ready();
    file = { ...file, path: this.sourcePath(vaultId, file.path) };
    const edit = this.snapshot.pending.findLast(
      (edit) => edit.vaultId === vaultId && edit.path === file.path,
    );
    if (edit) return edit.text;
    const key = `text:${vaultId}:${file.hash}`,
      cached = await this.get<string | null>(key, null);
    if (cached !== null && digest(encodeText(cached)) === file.hash) return cached;
    if (cached !== null) await this.host.call('remove', { key: this.namespace + key });
    const reply = await this.host.call<HttpReply>('http', {
      path: `/api/vaults/${vaultId}/file?path=${encodeURIComponent(file.path)}&revision=${file.revision}&encoding=text`,
      method: 'GET',
    });
    if (reply.status === 409) {
      void this.refresh();
      throw new Error('文档已更新，请重新打开；编辑草稿仍保留。');
    }
    let text = reply.body;
    if (digest(encodeText(text)) !== file.hash && digest(encodeText(`\uFEFF${text}`)) === file.hash)
      text = `\uFEFF${text}`;
    if (reply.status !== 200 || digest(encodeText(text)) !== file.hash)
      throw new Error('正文暂时无法读取，已保存的内容不会被替换。');
    await this.set(key, text);
    return text;
  }
  async readBytes(
    vaultId: string,
    file: VaultSummary,
    current: () => boolean = () => true,
  ): Promise<Uint8Array> {
    await this.ready();
    file = { ...file, path: this.sourcePath(vaultId, file.path) };
    if (!file.hash || file.size > 32 * 1024 * 1024) throw new Error('文件超过可读取范围。');
    const chunks: Uint8Array[] = [];
    let offset = 0;
    while (offset < file.size) {
      if (!current()) throw Object.assign(new Error('Reader closed'), { name: 'AbortError' });
      const key = `binary:${file.hash}:${offset}`;
      let encoded = await this.get<string | null>(key, null);
      if (encoded === null) {
        const part = await this.http<{ data: string; next: number }>(
          `/api/vaults/${vaultId}/file?path=${encodeURIComponent(file.path)}&revision=${file.revision}&encoding=base64&offset=${offset}`,
        );
        if (part.next <= offset) throw new Error('附件内容不完整。');
        encoded = part.data;
      }
      let bytes: Uint8Array;
      try {
        bytes = fromBase64(encoded);
        if (!bytes.length || bytes.length > 256 * 1024 || offset + bytes.length > file.size)
          throw new Error('incomplete');
      } catch {
        await this.host.call('remove', { key: this.namespace + key });
        throw new Error('附件缓存不完整，请联网后重新读取。');
      }
      await this.set(key, encoded);
      chunks.push(bytes);
      offset += bytes.length;
    }
    const bytes = new Uint8Array(file.size);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    if (digest(bytes) !== file.hash) {
      for (let at = 0; at < file.size; at += 256 * 1024)
        await this.host.call('remove', { key: this.namespace + `binary:${file.hash}:${at}` });
      throw new Error('附件校验失败，请联网后重新读取。');
    }
    return bytes;
  }
  /** Bounded content query for host/client bridges; the caller verifies the complete hash. */
  async readBinaryPart(vaultId: string, file: VaultSummary, offset: number): Promise<string> {
    await this.ready();
    file = { ...file, path: this.sourcePath(vaultId, file.path) };
    if (!isVaultId(vaultId) || !isVaultPath(file.path) || !file.hash || file.size > 32 * 1024 * 1024
      || !Number.isSafeInteger(offset) || offset < 0 || offset >= file.size || offset % (256 * 1024))
      throw new Error('INVALID_BINARY_RANGE');
    const key = `binary:${file.hash}:${offset}`;
    let encoded = await this.get<string | null>(key, null);
    if (encoded === null) {
      const part = await this.http<{ data: string; next: number }>(
        `/api/vaults/${vaultId}/file?path=${encodeURIComponent(file.path)}&revision=${file.revision}&encoding=base64&offset=${offset}`,
      );
      encoded = part.data;
    }
    const bytes = fromBase64(encoded);
    if (bytes.length !== Math.min(256 * 1024, file.size - offset)) throw new Error('INVALID_BINARY_RANGE');
    await this.set(key, encoded);
    return encoded;
  }
  async saveText(vaultId: string, path: string, text: string, baseRevision: number): Promise<void> {
    await this.ready();
    if (!isVaultId(vaultId) || !isVaultPath(path) || encodeText(text).length > EDIT_MAX_BYTES)
      throw new Error('文档过大或路径无效，内容已保留在编辑器中。');
    await this.mutate(async () => {
    const move = this.snapshot.moves?.find(move => move.vaultId === vaultId && (move.from === path || move.to === path));
    if (move?.attempted) throw Object.assign(new Error('请先完成移动同步，编辑草稿仍保留。'), { status: 423 });
    if (move?.status === 'pending') path = move.from;
    const pending = [...this.snapshot.pending],
      last = pending.findLastIndex(
        (edit) => edit.vaultId === vaultId && edit.path === path && edit.id !== this.sending,
      );
    if (last >= 0) pending[last] = { ...pending[last], text };
    else pending.push({ id: uniqueId(), vaultId, path, text, baseRevision, createdAt: Date.now() });
    await this.persist(false, true, { ...this.snapshot, pending });
    this.publish({ pending });
    });
    void this.refresh(true);
  }
  private async flush(): Promise<void> {
    while (this.snapshot.pending.length && !this.disposed) {
      const edit = { ...this.snapshot.pending[0] };
      this.sending = edit.id;
      let text = edit.text,
        revision = edit.baseRevision;
      const write = (path: string, base: number) =>
        this.http<VaultFile>(
          `/api/vaults/${edit.vaultId}/file?path=${encodeURIComponent(path)}`,
          'PUT',
          text,
          { 'x-vault-base-revision': String(base), 'content-type': 'text/plain; charset=utf-8' },
        );
      try {
        const reading =
          edit.path.startsWith('90_系统/umeda/reading/') && edit.path.endsWith('.json');
        let file: VaultFile | undefined,
          conflicted = false,
          incompatible = false;
        for (let attempt = 0; attempt < (reading ? 3 : 1); attempt++) {
          try {
            if (reading) {
              let head: VaultFile | null = null;
              try {
                head = await this.http<VaultFile>(
                  `/api/vaults/${edit.vaultId}/stat?path=${encodeURIComponent(edit.path)}`,
                );
              } catch (error) {
                if ((error as { status?: number }).status !== 404) throw error;
              }
              revision = head?.revision ?? 0;
              if (head && !head.deleted) {
                const reply = await this.host.call<HttpReply>('http', {
                  path: `/api/vaults/${edit.vaultId}/file?path=${encodeURIComponent(edit.path)}&revision=${head.revision}&encoding=text`,
                  method: 'GET',
                });
                if (reply.status !== 200)
                  throw Object.assign(new Error('阅读记录已更新。'), { status: reply.status });
                const merged = mergeReadingStates(text, reply.body);
                if (!merged) {
                  incompatible = true;
                  throw Object.assign(new Error('阅读记录版本不同，已保留原记录。'), {
                    status: 409,
                  });
                }
                text = merged;
              }
            }
            file = await write(edit.path, revision);
            break;
          } catch (error) {
            if ((error as { status?: number }).status !== 409) throw error;
            if (reading && !incompatible && attempt < 2) continue;
            const extension = /\.[^/.]+$/.exec(edit.path)?.[0] ?? '';
            const conflict = `${edit.path.slice(0, extension ? -extension.length : undefined)}.sync-conflict-${edit.id}${extension}`;
            file = await write(conflict, 0);
            conflicted = true;
            this.publish({ conflicts: [...this.snapshot.conflicts, conflict] });
            break;
          }
        }
        if (!file) throw new Error('保存未完成，本机草稿已保留。');
        if (file.hash !== digest(encodeText(text)))
          throw new Error('保存回执与原文不一致，本机草稿已保留。');
        await this.mutate(async () => {
        const accepted = file!;
        const pending = this.snapshot.pending
          .filter((item) => item.id !== edit.id)
          .map((item) =>
            !conflicted &&
            item.vaultId === edit.vaultId &&
            item.path === edit.path &&
            item.baseRevision === edit.baseRevision
              ? { ...item, baseRevision: accepted.revision }
              : item,
          );
        await this.set(`text:${edit.vaultId}:${accepted.hash}`, text);
        const nextFiles = new Map(
          (Object.hasOwn(this.snapshot.catalog.files, edit.vaultId) ? this.snapshot.catalog.files[edit.vaultId] : []).map((item) => [item.path, item]),
        );
        nextFiles.set(accepted.path, summaryFromText({ ...accepted, frontmatter: '', excerpt: '' }, text));
        const catalogFiles = { ...this.snapshot.catalog.files };
        Object.defineProperty(catalogFiles, edit.vaultId, {
          value: [...nextFiles.values()],
          writable: true,
          enumerable: true,
          configurable: true,
        });
        const catalog = { ...this.snapshot.catalog, files: catalogFiles };
        const moves = (this.snapshot.moves ?? []).map(move => !conflicted && move.vaultId === edit.vaultId && move.from === edit.path && move.baseRevision === edit.baseRevision
          ? { ...move, baseRevision: accepted.revision, file: nextFiles.get(accepted.path)! } : move);
        await this.persist(true, true, { ...this.snapshot, pending, catalog, moves });
        this.publish({ pending, catalog, moves });
        });
      } finally {
        this.sending = null;
      }
    }
  }
  /** Only active Desktop plugin views need HTTP hints; native hosts use their existing socket. */
  watch(vaultId: string): () => void {
    let stopped = false,
      failures = 0,
      timer: ReturnType<typeof setTimeout> | undefined,
      resume: (() => void) | undefined;
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      resume?.();
      this.liveStops.delete(stop);
    };
    this.liveStops.add(stop);
    void (async () => {
      while (!stopped && !this.disposed) {
        try {
          const after = Object.hasOwn(this.snapshot.catalog.cursors, vaultId) ? this.snapshot.catalog.cursors[vaultId] : 0;
          const event = await this.http<{ revision: number; changed: boolean; reset?: boolean }>(
            `/api/vaults/${vaultId}/watch?after=${after}&wait=20000`,
          );
          if (stopped || this.disposed) return;
          if (
            !Number.isSafeInteger(event.revision) ||
            event.revision < 0 ||
            typeof event.changed !== 'boolean'
          )
            return;
          if (event.reset) {
            const cursors = { ...this.snapshot.catalog.cursors, [vaultId]: 0 },
              files = { ...this.snapshot.catalog.files, [vaultId]: [] };
            this.publish({ catalog: { ...this.snapshot.catalog, cursors, files } });
          }
          if (event.changed || event.reset) await this.refresh(true);
          failures = 0;
        } catch (error) {
          if (
            stopped ||
            this.disposed ||
            [400, 404, 405, 501].includes((error as { status?: number }).status ?? 0)
          )
            return;
          const delay = Math.min(60000, 2000 * 2 ** Math.min(failures++, 5));
          await new Promise<void>((resolve) => {
            resume = resolve;
            timer = setTimeout(resolve, delay);
          });
        }
      }
    })().finally(stop);
    return stop;
  }
  async preference<T>(key: string, fallback: T): Promise<T> {
    await this.ready();
    return this.get(`preference:${safeKey(key)}`, fallback);
  }
  async search(vaultId: string, query: string): Promise<SearchResults> {
    const started = monotonicNow();
    try { return await this.searchNow(vaultId, query); }
    finally { this.observe('search', started); }
  }
  private bookFile(vaultId: string, file: VaultSummary) {
    if (!isVaultId(vaultId) || !file?.hash || !/^[a-f0-9]{64}$/.test(file.hash) || !/\.(pdf|epub)$/i.test(file.path) || file.size > 32 * 1024 * 1024) throw new Error('INVALID_BOOK_INDEX');
    const current = this.files(vaultId).find(item => file.documentId ? item.documentId === file.documentId : item.path === file.path);
    if (!current || current.hash !== file.hash) throw Object.assign(new Error('BOOK_VERSION_CHANGED'), { status: 409 });
    return `${vaultId}:${file.hash}`;
  }
  async indexBookPart(vaultId: string, file: VaultSummary, position: number, part: BookTextPart): Promise<void> {
    await this.ready();
    if (!Number.isSafeInteger(position) || position < 0 || position >= 5000 || typeof part?.text !== 'string' || encodeText(part.text).length > 128 * 1024 || typeof part.location !== 'string' || !part.location || part.location.length > 2000 || typeof part.label !== 'string' || part.label.length > 500) throw new Error('INVALID_BOOK_INDEX');
    await this.mutate(async () => {
      const identity = this.bookFile(vaultId, file), index = this.bookIndexes[identity] ?? { parts: [], complete: false, bytes: 0 };
      const key = `extracted:${identity}:${position}`;
      if (position < index.parts.length) {
        if (await this.get(key, '') !== part.text || index.parts[position].location !== part.location || index.parts[position].label !== part.label) throw new Error('BOOK_INDEX_MISMATCH');
        return;
      }
      if (position !== index.parts.length || index.complete || index.bytes + encodeText(part.text).length > 32 * 1024 * 1024) throw new Error('BOOK_INDEX_LIMIT');
      const bookIndexes = { ...this.bookIndexes, [identity]: { parts: [...index.parts, { location: part.location, label: part.label }], complete: false, bytes: index.bytes + encodeText(part.text).length } };
      if (this.atomic) await this.host.call('commit', { entries: [{ key: this.namespace + key, value: JSON.stringify(part.text) }, { key: this.namespace + 'book-indexes', value: JSON.stringify(bookIndexes) }] });
      else { await this.set(key, part.text); await this.set('book-indexes', bookIndexes); }
      this.bookIndexes = bookIndexes; this.publish({ bookIndexes: this.bookSummary() });
    });
  }
  async completeBookIndex(vaultId: string, file: VaultSummary, count: number): Promise<void> {
    await this.ready();
    await this.mutate(async () => {
      const identity = this.bookFile(vaultId, file), index = this.bookIndexes[identity];
      if (!index || !Number.isSafeInteger(count) || count !== index.parts.length) throw new Error('INVALID_BOOK_INDEX');
      const bookIndexes = { ...this.bookIndexes, [identity]: { ...index, complete: true } };
      await this.set('book-indexes', bookIndexes); this.bookIndexes = bookIndexes; this.publish({ bookIndexes: this.bookSummary() });
    });
  }
  private async searchNow(vaultId: string, query: string): Promise<SearchResults> {
    await this.ready();
    if (!isVaultId(vaultId) || typeof query !== 'string' || query.length > 200) throw new Error('INVALID_LIBRARY_SEARCH');
    const term = query.trim().toLowerCase(), files = this.files(vaultId).filter(f => !f.path.startsWith('90_系统/umeda/'));
    const books = files.filter(file => /\.(pdf|epub)$/i.test(file.path));
    const eligible = files.filter(f => textFile(f.path) && f.size <= EDIT_MAX_BYTES);
    const keys = eligible.filter(f => f.hash).map(f => this.namespace + `text:${vaultId}:${f.hash}`);
    const bookKeys = new Map<string, Array<{ key: string; location: string; label: string }>>();
    for (const file of books) {
      const identity = `${vaultId}:${file.hash}`, index = this.bookIndexes[identity];
      if (!index?.complete) continue;
      const parts = index.parts.map((part, position) => ({ ...part, key: this.namespace + `extracted:${identity}:${position}` }));
      bookKeys.set(file.path, parts); keys.push(...parts.map(part => part.key));
    }
    let result: { hits: Array<{ key: string; snippet: string }>; covered: number; coveredKeys: string[] };
    if (this.contentSearch) result = await this.host.call('contentSearch', { keys, query: term });
    else {
      // Compatibility for old hosts; never download content just because someone searches.
      const hits = [], coveredKeys = [];
      for (const file of eligible) {
        const text = await this.get<string | null>(`text:${vaultId}:${file.hash}`, null);
        if (text === null) continue;
        coveredKeys.push(this.namespace + `text:${vaultId}:${file.hash}`);
        const at = text.toLowerCase().indexOf(term);
        if (term && at >= 0) hits.push({ key: this.namespace + `text:${vaultId}:${file.hash}`, snippet: text.slice(Math.max(0, at - 50), Math.max(0, at - 50) + 190) });
      }
      for (const parts of bookKeys.values()) for (const part of parts) {
        const text = await this.get<string | null>(part.key.slice(this.namespace.length), null);
        if (text === null) continue;
        coveredKeys.push(part.key);
        const at = text.toLowerCase().indexOf(term);
        if (term && at >= 0) hits.push({ key: part.key, snippet: text.slice(Math.max(0, at - 50), Math.max(0, at - 50) + 190) });
      }
      result = { hits, covered: coveredKeys.length, coveredKeys };
    }
    const byKey = new Map(result.hits.map(hit => [hit.key, hit.snippet]));
    const hits: SearchResults['hits'] = [];
    for (const file of files) {
      const pending = this.snapshot.pending.findLast(edit => edit.vaultId === vaultId && edit.path === this.sourcePath(vaultId, file.path));
      const bodySnippet = pending ? (pending.text.toLowerCase().includes(term) ? pending.text.slice(Math.max(0, pending.text.toLowerCase().indexOf(term) - 50), Math.max(0, pending.text.toLowerCase().indexOf(term) - 50) + 190) : undefined) : byKey.get(this.namespace + `text:${vaultId}:${file.hash}`);
      const bookHit = bookKeys.get(file.path)?.find(part => byKey.has(part.key));
      if (term && (`${file.path} ${file.excerpt} ${file.frontmatter}`.toLowerCase().includes(term) || bodySnippet !== undefined || bookHit)) hits.push({ file, snippet: (bodySnippet ?? (bookHit ? byKey.get(bookHit.key)! : file.excerpt)).slice(0, 190), location: bookHit?.location, label: bookHit?.label });
    }
    const coveredKeys = new Set(result.coveredKeys), edited = new Set(this.snapshot.pending.filter(edit => edit.vaultId === vaultId).map(edit => edit.path));
    return { hits: hits.slice(0, 200), more: hits.length > 200 || result.hits.length > 200, covered: eligible.filter(file => edited.has(this.sourcePath(vaultId, file.path)) || coveredKeys.has(this.namespace + `text:${vaultId}:${file.hash}`)).length + books.filter(file => bookKeys.has(file.path) && bookKeys.get(file.path)!.every(part => coveredKeys.has(part.key))).length, total: eligible.length + books.length };
  }
  private async saveDownloads(downloads: OfflineFile[]) {
    await this.set('offline-files', downloads);
    this.publish({ downloads });
  }
  async pinOffline(vaultId: string, path?: string): Promise<void> {
    await this.ready();
    if (!isVaultId(vaultId) || (path !== undefined && !isVaultPath(path))) throw new Error('INVALID_LIBRARY_PATH');
    const files = this.files(vaultId).filter(file => !file.deleted && !file.path.startsWith('90_系统/umeda/') && (path ? file.path === path : textFile(file.path) && file.size <= EDIT_MAX_BYTES));
    if (path && !files.length) throw new Error('LIBRARY_FILE_UNAVAILABLE');
    if (files.some(file => file.size > 32 * 1024 * 1024 || (textFile(file.path) && file.size > EDIT_MAX_BYTES))) throw new Error('LIBRARY_OFFLINE_SIZE_LIMIT');
    await this.mutate(async () => {
      const downloads = [...(this.snapshot.downloads ?? [])];
      for (const file of files) {
        const at = downloads.findIndex(job => job.vaultId === vaultId && (file.documentId ? job.documentId === file.documentId : job.path === file.path));
        const job: OfflineFile = { vaultId, path: file.path, documentId: file.documentId, status: 'pending' };
        if (at < 0) downloads.push(job); else downloads[at] = job;
      }
      await this.saveDownloads(downloads);
    });
    void this.syncOffline();
  }
  async cancelOffline(vaultId: string, path: string): Promise<void> {
    await this.ready();
    await this.mutate(() => this.saveDownloads((this.snapshot.downloads ?? []).filter(job => job.vaultId !== vaultId || job.path !== path)));
  }
  /** Serial download worker. Each verified chunk is retained for restart/cancel/resume. */
  syncOffline(): Promise<void> {
    if (this.downloading) return this.downloading;
    this.downloading = (async () => {
      await this.ready();
      for (const job of [...(this.snapshot.downloads ?? [])]) {
        if (this.disposed) return;
        const file = this.files(job.vaultId).find(f => job.documentId ? f.documentId === job.documentId : f.path === job.path);
        if (!file || (job.status === 'ready' && job.hash === file.hash)) continue;
        const current = () => !this.disposed && (this.snapshot.downloads ?? []).includes(job);
        try {
          if (!current()) continue;
          if (textFile(file.path)) await this.readText(job.vaultId, file);
          else {
            const hash = sha256.create();
            for (let offset = 0; offset < file.size; offset += 256 * 1024) {
              if (!current()) break;
              hash.update(fromBase64(await this.readBinaryPart(job.vaultId, file, offset)));
            }
            if (current() && bytesToHex(hash.digest()) !== file.hash) {
              for (let at = 0; at < file.size; at += 256 * 1024) await this.host.call('remove', { key: this.namespace + `binary:${file.hash}:${at}` });
              throw new Error('VAULT_HASH_MISMATCH');
            }
          }
          await this.mutate(async () => {
            if (!current()) return;
            await this.saveDownloads((this.snapshot.downloads ?? []).map(item => item === job ? { ...item, path: file.path, hash: file.hash ?? undefined, status: 'ready' } : item));
          });
        } catch {
          if (this.disposed) return;
          await this.mutate(async () => { if (current()) await this.saveDownloads((this.snapshot.downloads ?? []).map(item => item === job ? { ...item, status: 'error' } : item)); });
          return; // One network failure must not cause one failing request per queued document.
        }
      }
    })().catch(() => undefined).finally(() => { this.downloading = null; });
    return this.downloading;
  }
  async savePreference(key: string, value: unknown): Promise<void> {
    await this.ready();
    await this.set(`preference:${safeKey(key)}`, value);
  }
  async history(vaultId: string, path: string, before?: number): Promise<{ files: VaultFile[]; more: boolean; indexing?: boolean; indexCursor?: string }> {
    await this.ready();
    path = this.sourcePath(vaultId, path);
    if (!isVaultId(vaultId) || !isVaultPath(path)) throw new Error('INVALID_LIBRARY_PATH');
    const result = await this.http<{ files: VaultFile[]; more: boolean; indexing?: boolean; indexCursor?: string }>(`/api/vaults/${vaultId}/history?path=${encodeURIComponent(path)}${before ? `&before=${before}` : ''}`);
    return { ...result, files: result.files.map(file => ({ ...file, path })) };
  }
  async readVersion(vaultId: string, file: VaultFile): Promise<string> {
    await this.ready();
    if (!isVaultId(vaultId) || !isVaultPath(file.path) || file.size > EDIT_MAX_BYTES || !Number.isSafeInteger(file.revision) || file.revision < 1) throw new Error('INVALID_LIBRARY_VERSION');
    const reply = await this.host.call<HttpReply>('http', { path: `/api/vaults/${vaultId}/history?path=${encodeURIComponent(file.path)}&revision=${file.revision}`, method: 'GET' });
    let text = reply.body;
    if (digest(encodeText(text)) !== file.hash && digest(encodeText(`\uFEFF${text}`)) === file.hash) text = `\uFEFF${text}`;
    if (reply.status !== 200 || digest(encodeText(text)) !== file.hash) throw new Error('VAULT_HASH_MISMATCH');
    await this.set(`text:${vaultId}:${file.hash}`, text);
    return text;
  }
  async restore(vaultId: string, path: string, revision: number, baseRevision: number): Promise<void> {
    await this.changeDocument('restore', vaultId, path, { revision, baseRevision });
  }
  async move(vaultId: string, path: string, to: string, baseRevision: number): Promise<void> {
    await this.ready();
    if (!isVaultId(vaultId) || !isVaultPath(path) || !isVaultPath(to) || path === to) throw new Error('INVALID_LIBRARY_PATH');
    await this.mutate(async () => {
      if (!this.snapshot.catalog.capabilities?.includes('vault-library-v1')) throw new Error('LIBRARY_MOVE_UNAVAILABLE');
      const file = this.files(vaultId).find(file => file.path === path);
      if (!file?.documentId || !file.revision) throw new Error('请先同步新文档，再移动。');
      if (file.revision !== baseRevision) throw Object.assign(new Error('文档已更新，请重新打开移动窗口。'), { status: 409 });
      const previous = this.snapshot.moves?.find(move => move.vaultId === vaultId && move.documentId === file.documentId);
      if (previous?.attempted || previous?.status === 'conflict') throw Object.assign(new Error('请先处理上一次移动。'), { status: 423 });
      if (this.files(vaultId).some(file => file.path === to) || this.snapshot.moves?.some(move => move !== previous && move.vaultId === vaultId && (move.from === to || move.to === to))) throw Object.assign(new Error('目标路径已有文档。'), { status: 409 });
      const operation: PendingMove = previous ? { ...previous, to } : { id: uniqueId(), vaultId, from: path, to, documentId: file.documentId, baseRevision, file, status: 'pending' };
      const moves = [...(this.snapshot.moves ?? []).filter(move => move.id !== operation.id), operation].filter(move => move.from !== move.to);
      await this.persist(false, false, { ...this.snapshot, moves }, true);
      this.publish({ moves });
    });
    void this.refresh(true);
  }
  async cancelMove(vaultId: string, id: string): Promise<void> {
    await this.ready();
    await this.mutate(async () => {
      if (this.moving === id) throw Object.assign(new Error('移动正在同步，请稍后再试。'), { status: 423 });
      const moves = (this.snapshot.moves ?? []).filter(move => move.vaultId !== vaultId || move.id !== id);
      await this.persist(false, false, { ...this.snapshot, moves }, true); this.publish({ moves });
    });
    void this.refresh(true);
  }
  async retryMove(vaultId: string, id: string): Promise<void> {
    await this.ready();
    const operation = this.snapshot.moves?.find(move => move.vaultId === vaultId && move.id === id);
    if (!operation || this.moving === id) return;
    const source = await this.http<VaultFile>(`/api/vaults/${vaultId}/stat?path=${encodeURIComponent(operation.from)}`);
    if (source.documentId !== operation.documentId || source.deleted) throw Object.assign(new Error('源文档已移动或删除，请先同步目录。'), { status: 409 });
    await this.mutate(async () => {
      if (this.moving === id) throw Object.assign(new Error('移动正在同步。'), { status: 423 });
      const moves = (this.snapshot.moves ?? []).map(move => move === operation ? { ...move, baseRevision: source.revision, file: { ...move.file, ...source }, status: 'pending' as const, attempted: false } : move);
      await this.persist(false, false, { ...this.snapshot, moves }, true); this.publish({ moves });
    });
    await this.refresh(true);
  }
  private async flushMoves(): Promise<void> {
    for (const queued of [...(this.snapshot.moves ?? [])]) {
      if (this.disposed) return;
      let operation: PendingMove | undefined;
      await this.mutate(async () => {
        const candidate = this.snapshot.moves?.find(move => move.id === queued.id && move.status === 'pending');
        if (!candidate || this.snapshot.pending.some(edit => edit.vaultId === candidate.vaultId && edit.path === candidate.from)) { if (candidate) this.refreshAgain = true; return; }
        operation = { ...candidate, attempted: true };
        const moves = this.snapshot.moves!.map(move => move.id === queued.id ? operation! : move);
        await this.persist(false, false, { ...this.snapshot, moves }, true);
        this.moving = operation.id; this.publish({ moves });
      });
      if (!operation) continue;
      const move = operation;
      try {
        let receipt: { files: VaultFile[] };
        try {
          receipt = await this.http(`/api/vaults/${move.vaultId}/move`, 'PUT', JSON.stringify({ path: move.from, to: move.to, baseRevision: move.baseRevision }), { 'content-type': 'application/json' });
        } catch (error) {
          if (![404, 409].includes((error as { status?: number }).status ?? 0)) throw error;
          // A committed move can lose its HTTP/local receipt. Identity + alias proves that
          // exact destination; a repeated CAS must never overwrite a reused source path.
          let target: VaultFile | undefined;
          try { target = await this.http<VaultFile>(`/api/vaults/${move.vaultId}/stat?path=${encodeURIComponent(move.to)}`); }
          catch (statError) { if ((statError as { status?: number }).status !== 404) throw statError; }
          if (!target || target.deleted || target.documentId !== move.documentId || !target.aliases?.includes(move.from)) {
            await this.mutate(async () => {
              const moves = (this.snapshot.moves ?? []).map(item => item.id === move.id ? { ...item, status: 'conflict' as const } : item);
              await this.persist(false, false, { ...this.snapshot, moves }, true); this.publish({ moves });
            });
            continue;
          }
          const source = await this.http<VaultFile>(`/api/vaults/${move.vaultId}/stat?path=${encodeURIComponent(move.from)}`);
          receipt = { files: [source, target] };
        }
        if (!receipt.files.some(file => file.path === move.to && !file.deleted && file.documentId === move.documentId && file.aliases?.includes(move.from))) throw new Error('INVALID_LIBRARY_RECEIPT');
        await this.acceptFiles(move.vaultId, receipt.files, move.id);
      } finally { this.moving = null; }
    }
  }
  async storageReport(): Promise<StorageReport | null> {
    await this.ready();
    if (!this.hasStorageReport) return null;
    const keys: string[] = [];
    for (const job of this.snapshot.downloads ?? []) {
      const file = this.files(job.vaultId).find(file => job.documentId ? file.documentId === job.documentId : file.path === job.path);
      for (const hash of new Set([job.hash, file?.hash])) {
        if (!hash) continue;
        keys.push(this.namespace + `text:${job.vaultId}:${hash}`);
        const size = file?.size ?? 32 * 1024 * 1024;
        for (let at = 0; at < size; at += 256 * 1024) keys.push(this.namespace + `binary:${hash}:${at}`);
      }
    }
    return this.host.call('storageReport', { namespace: this.namespace, pinnedKeys: keys });
  }
  private async changeDocument(action: string, vaultId: string, path: string, extra: Record<string, unknown>) {
    await this.ready();
    if (!isVaultId(vaultId) || !isVaultPath(path)) throw new Error('INVALID_LIBRARY_PATH');
    if (this.snapshot.pending.some(edit => edit.vaultId === vaultId && edit.path === path)) throw Object.assign(new Error('请先同步这份文档的修改。'), { status: 423 });
    if (this.snapshot.moves?.some(move => move.vaultId === vaultId && (move.from === path || move.to === path))) throw Object.assign(new Error('请先完成这份文档的移动。'), { status: 423 });
    const receipt = await this.http<{ files: VaultFile[] }>(`/api/vaults/${vaultId}/${action}`, 'PUT', JSON.stringify({ path, ...extra }), { 'content-type': 'application/json' });
    await this.acceptFiles(vaultId, receipt.files);
    await this.refresh(true);
  }
  private async acceptFiles(vaultId: string, receipts: VaultFile[], moveId?: string) {
    await this.mutate(async () => {
      const previous = Object.hasOwn(this.snapshot.catalog.files, vaultId) ? this.snapshot.catalog.files[vaultId] : [], files = new Map(previous.map(file => [file.path, file]));
      const deleted = new Map((Object.hasOwn(this.snapshot.catalog.trash ?? {}, vaultId) ? this.snapshot.catalog.trash![vaultId] : []).map(file => [file.path, file]));
      for (const file of receipts) {
        if (!isVaultPath(file.path) || !Number.isSafeInteger(file.revision)) throw new Error('INVALID_LIBRARY_RECEIPT');
        if ((files.get(file.path)?.revision ?? 0) > file.revision) continue;
        if (file.deleted) { files.delete(file.path); if (!file.movedTo) deleted.set(file.path, { ...file, frontmatter: '', excerpt: '' }); }
        else {
          const cached = await this.get<string | null>(`text:${vaultId}:${file.hash}`, null);
          const summary = previous.find(item => item.hash === file.hash);
          const next = { ...file, frontmatter: summary?.frontmatter ?? '', excerpt: summary?.excerpt ?? '' };
          files.set(file.path, cached !== null && digest(encodeText(cached)) === file.hash ? summaryFromText(next, cached) : next);
          deleted.delete(file.path);
        }
      }
      const catalogFiles = { ...this.snapshot.catalog.files }, trash = { ...this.snapshot.catalog.trash };
      Object.defineProperty(catalogFiles, vaultId, { value: [...files.values()], writable: true, enumerable: true, configurable: true });
      Object.defineProperty(trash, vaultId, { value: [...deleted.values()], writable: true, enumerable: true, configurable: true });
      const catalog = { ...this.snapshot.catalog, files: catalogFiles, trash };
      const moves = (this.snapshot.moves ?? []).filter(move => move.id !== moveId);
      await this.persist(true, false, { ...this.snapshot, catalog, moves }, !!moveId);
      this.publish({ catalog, moves });
    });
  }
  async capture(vaultId: string, title: string, body: string): Promise<string> {
    const safe =
      title
        .trim()
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, '-')
        .slice(0, 120) || '随手记';
    const path = `10_收件箱/${localDay()}-${safe}-${uniqueId().slice(-8)}.md`;
    await this.saveText(vaultId, path, `# ${title.trim() || '随手记'}\n\n${body}\n`, 0);
    return path;
  }
  dispose() {
    this.disposed = true;
    for (const stop of this.liveStops) stop();
    this.listeners.clear();
  }
}
