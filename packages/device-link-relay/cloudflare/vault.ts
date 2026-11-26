import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import {
  isVaultId,
  isVaultPath,
  VAULT_FILE_MAX_BYTES,
  type VaultFile,
  type VaultInfo,
  type VaultSummary,
} from '@cindy/device-link';
import { RelayError } from '../src/errors';
import { readJson } from './requestJson';
import type { ObjectStorage } from './runtime';

/** Minimal R2 binding port, shared by workerd and in-memory contract tests. */
export interface VaultBucket {
  put(key: string, value: Uint8Array): Promise<unknown>;
  get(
    key: string,
    options?: { range: { offset: number; length: number } },
  ): Promise<{ body: ReadableStream<Uint8Array> } | null>;
}
type IndexSummary = Pick<VaultSummary, 'frontmatter' | 'excerpt' | 'indexError'>;
type IndexedFile = VaultFile & { summary?: IndexSummary };
function summary(bytes: Uint8Array): IndexSummary {
  const text = new TextDecoder().decode(bytes.subarray(0, 20 * 1024));
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(text);
  const indexError =
    match && match[1].length > 16 * 1024
      ? 'frontmatter-too-large'
      : !match && /^(?:\uFEFF)?---\r?\n/.test(text)
        ? 'frontmatter-unclosed'
        : undefined;
  return {
    frontmatter: match && !indexError ? match[1] : '',
    excerpt: text.slice(match?.[0].length ?? 0).slice(0, 600),
    ...(indexError ? { indexError } : {}),
  };
}
function documentId(id: string, file: VaultFile): string {
  return file.documentId ?? createHash('sha256').update(JSON.stringify(['umeda-document-v1', id, file.path])).digest('hex');
}
function publicFile(file: VaultFile, id: string): VaultFile {
  const { path, revision, hash, size, modifiedAt, deleted } = file;
  return { path, revision, hash, size, modifiedAt, deleted, documentId: documentId(id, file), ...(file.aliases ? { aliases: file.aliases } : {}), ...(file.movedTo ? { movedTo: file.movedTo } : {}) };
}
const ROOT = 'vault-v1:';
const json = (data: unknown) =>
  Response.json(data, {
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });

interface FileIndex {
  byPath: Map<string, IndexedFile>;
  ordered: IndexedFile[];
}

export class CloudVault {
  private serial: Promise<unknown> = Promise.resolve();
  private indexes = new Map<string, FileIndex>();
  private summaries = new Map<string, Promise<IndexedFile>>();
  private transferBytes = 0;
  private transfers: Array<{ bytes: number; start(): void }> = [];
  private waiters = new Map<string, Set<() => void>>();
  constructor(
    private readonly storage: ObjectStorage,
    private readonly bucket: VaultBucket,
    private readonly changed: (vaultId: string, revision: number) => void = () => undefined,
  ) {}
  private metadata<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.catch(() => undefined).then(operation);
    this.serial = result;
    return result;
  }
  private reserve(bytes: number, signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const job = {
        bytes,
        start: () => {
          signal.removeEventListener('abort', abort);
          let released = false;
          this.transferBytes += bytes;
          resolve(() => {
            if (released) return;
            released = true;
            this.transferBytes -= bytes;
            this.admit();
          });
        },
      };
      const abort = () => {
        this.transfers = this.transfers.filter((item) => item !== job);
        reject(new RelayError('BAD_REQUEST', 'upload cancelled'));
        this.admit();
      };
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      this.transfers.push(job);
      this.admit();
    });
  }
  private admit() {
    while (
      this.transfers.length &&
      this.transferBytes + this.transfers[0].bytes <= 64 * 1024 * 1024
    )
      this.transfers.shift()!.start();
  }
  private fileKey(id: string, path: string) {
    return `${ROOT}file:${id}:${createHash('sha256').update(path).digest('hex')}`;
  }
  private versionKey(id: string, file: VaultFile) {
    return `${ROOT}versions:${id}:${documentId(id, file)}:${String(file.revision).padStart(16, '0')}`;
  }
  /** Bounded copy-forward index. Historical bytes/records are never rewritten or removed. */
  private async indexHistory(id: string): Promise<{ done: boolean; after: string }> {
    const key = `${ROOT}history-index:${id}`;
    const state = await this.storage.get<{ after: string; done: boolean }>(key);
    if (state?.done) return state;
    const entries = await this.storage.list<IndexedFile>({ prefix: `${ROOT}history:${id}:`, ...(state?.after ? { startAfter: state.after } : {}), limit: 128 });
    await Promise.all([...entries.values()].map(file => this.storage.put(this.versionKey(id, file), file)));
    const done = entries.size < 128;
    const next = { after: [...entries.keys()].at(-1) ?? state?.after ?? '', done };
    await this.storage.put(key, next);
    return next;
  }
  private async index(id: string): Promise<FileIndex> {
    let index = this.indexes.get(id);
    if (!index) {
      const files = [
        ...(await this.storage.list<IndexedFile>({ prefix: `${ROOT}file:${id}:` })).values(),
      ];
      index = {
        byPath: new Map(files.map((file) => [file.path, file])),
        ordered: files.sort((a, b) => a.revision - b.revision),
      };
      this.indexes.set(id, index);
    }
    return index;
  }
  private remember(id: string, file: IndexedFile) {
    const index = this.indexes.get(id);
    if (!index) return;
    index.byPath.set(file.path, file);
    index.ordered = [...index.ordered.filter((previous) => previous.path !== file.path), file].sort(
      (a, b) => a.revision - b.revision,
    );
  }
  private notify(id: string, revision: number) {
    for (const listener of this.waiters.get(id) ?? []) listener();
    try {
      this.changed(id, revision);
    } catch {
      /* A hint never changes an accepted save. */
    }
  }
  handle(request: Request): Promise<Response> {
    return this.route(request);
  }
  private async summarized(id: string, file: IndexedFile): Promise<IndexedFile> {
    if (file.deleted || !/\.md$/i.test(file.path) || file.summary) return file;
    const key = `${id}:${file.revision}`,
      existing = this.summaries.get(key);
    if (existing) return existing;
    const work = (async () => {
      const object = file.size
        ? await this.bucket.get(`vault-v1/${id}/${file.hash}`, {
            range: { offset: 0, length: Math.min(file.size, 20 * 1024) },
          })
        : null;
      if (file.size && !object) throw new RelayError('STATE_INVALID', 'file content missing');
      const updated = {
        ...file,
        summary: summary(
          object ? new Uint8Array(await new Response(object.body).arrayBuffer()) : new Uint8Array(),
        ),
      };
      await this.metadata(async () => {
        const current = await this.storage.get<IndexedFile>(this.fileKey(id, file.path));
        if (current?.revision === file.revision) {
          await this.storage.put(this.fileKey(id, file.path), updated);
          this.remember(id, updated);
        }
      });
      return updated;
    })().finally(() => this.summaries.delete(key));
    this.summaries.set(key, work);
    return work;
  }
  private async page(
    id: string,
    after: number,
    indexed: boolean,
    budget: number | null,
  ): Promise<Response> {
    const candidates = await this.metadata(async () => {
      const { ordered } = await this.index(id);
      let low = 0,
        high = ordered.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (ordered[middle].revision <= after) low = middle + 1;
        else high = middle;
      }
      return {
        files: ordered.slice(low, low + (indexed ? (budget ? 1000 : 40) : 200)),
        remaining: ordered.length - low,
      };
    });
    const files: Array<VaultFile | VaultSummary> = [];
    let bytes = 128,
      legacy = 0;
    for (const candidate of candidates.files) {
      if (
        indexed &&
        !candidate.deleted &&
        /\.md$/i.test(candidate.path) &&
        !candidate.summary &&
        legacy++ >= 16
      )
        break;
      const file = indexed ? await this.summarized(id, candidate) : candidate;
      const item = indexed
        ? {
            ...publicFile(file, id),
            frontmatter: file.summary?.frontmatter ?? '',
            excerpt: file.summary?.excerpt ?? '',
            ...(file.summary?.indexError ? { indexError: file.summary.indexError } : {}),
          }
        : publicFile(file, id);
      const size = Buffer.byteLength(JSON.stringify(item)) + 1;
      if (budget && files.length && bytes + size > budget) break;
      bytes += size;
      files.push(item);
    }
    return json({
      files,
      cursor: files.at(-1)?.revision ?? after,
      more: candidates.remaining > files.length,
    });
  }
  private watch(request: Request, id: string, after: number, wait: number): Promise<Response> {
    return new Promise((resolve, reject) => {
      let ended = false;
      const listeners = this.waiters.get(id) ?? new Set<() => void>();
      this.waiters.set(id, listeners);
      const finish = (response?: Response, error?: unknown) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        listeners.delete(listener);
        if (!listeners.size && this.waiters.get(id) === listeners) this.waiters.delete(id);
        request.signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(response!);
      };
      const check = async (expired = false) => {
        try {
          const revision = await this.metadata(
            async () => (await this.index(id)).ordered.at(-1)?.revision ?? 0,
          );
          if (expired || revision !== after)
            finish(
              json({
                revision,
                changed: revision > after,
                ...(revision < after ? { reset: true } : {}),
              }),
            );
        } catch (error) {
          finish(undefined, error);
        }
      };
      const listener = () => {
          void check();
        },
        abort = () => finish(json({ revision: after, changed: false }));
      const timer = setTimeout(() => {
        void check(true);
      }, wait);
      listeners.add(listener);
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      else void check();
    });
  }
  private async route(request: Request): Promise<Response> {
    const url = new URL(request.url),
      parts = url.pathname.split('/').slice(3);
    if (!parts[0] && request.method === 'GET')
      return this.metadata(async () =>
        json({
          features: ['vault-library-v1'],
          vaults: [...(await this.storage.list<VaultInfo>({ prefix: `${ROOT}info:` })).values()],
        }),
      );
    const [id, action] = parts;
    if (!isVaultId(id) || parts.length > 2)
      throw new RelayError('BAD_REQUEST', 'invalid vault route');
    const infoKey = `${ROOT}info:${id}`;
    if (!action && request.method === 'PUT') {
      const { name } = await readJson(request);
      if (typeof name !== 'string' || !name.trim() || name.length > 120)
        throw new RelayError('BAD_REQUEST', 'invalid vault name');
      return this.metadata(async () => {
        const previous = await this.storage.get<VaultInfo>(infoKey);
        if (previous?.name !== name.trim())
          await this.storage.put(infoKey, { id, name: name.trim() });
        return json({ id, name: name.trim() });
      });
    }
    if (!(await this.storage.get(infoKey))) throw new RelayError('NOT_FOUND', 'vault not found');
    if (action === 'history' && request.method === 'GET') {
      const selected = url.searchParams.get('path'), after = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER);
      if (!isVaultPath(selected) || !Number.isSafeInteger(after) || after < 1) throw new RelayError('BAD_REQUEST', 'invalid history');
      const selectedRevision = url.searchParams.get('revision');
      if (selectedRevision !== null) {
        if (!/^[1-9][0-9]{0,15}$/.test(selectedRevision)) throw new RelayError('BAD_REQUEST', 'invalid version');
        const file = await this.metadata(async () => {
          const current = await this.storage.get<IndexedFile>(this.fileKey(id, selected));
          const historical = await this.storage.get<IndexedFile>(`${ROOT}history:${id}:${selectedRevision}`);
          if (!current || !historical || historical.deleted || documentId(id, historical) !== documentId(id, current)) throw new RelayError('NOT_FOUND', 'version not found');
          return historical;
        });
        const object = await this.bucket.get(`vault-v1/${id}/${file.hash}`);
        if (!object) throw new RelayError('NOT_FOUND', 'version content unavailable');
        return new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
      }
      return this.metadata(async () => {
        const current = await this.storage.get<IndexedFile>(this.fileKey(id, selected));
        if (!current) throw new RelayError('NOT_FOUND', 'file not found');
        const indexed = await this.indexHistory(id);
        const prefix = `${ROOT}versions:${id}:${documentId(id, current)}:`;
        const files = [...(await this.storage.list<IndexedFile>({ prefix, end: prefix + String(after).padStart(16, '0'), reverse: true, limit: 51 })).values()];
        return json({ files: files.slice(0, 50).map(file => publicFile(file, id)), more: files.length > 50, indexing: !indexed.done, indexCursor: indexed.after });
      });
    }
    if ((action === 'move' || action === 'restore') && request.method === 'PUT') {
      const body = await readJson(request);
      if (!isVaultPath(body.path) || !Number.isSafeInteger(body.baseRevision) || Number(body.baseRevision) < 1)
        throw new RelayError('BAD_REQUEST', 'invalid document change');
      if (action === 'move' && (!isVaultPath(body.to) || body.to === body.path)) throw new RelayError('BAD_REQUEST', 'invalid target');
      if (action === 'restore' && (!Number.isSafeInteger(body.revision) || Number(body.revision) < 1)) throw new RelayError('BAD_REQUEST', 'invalid version');
      const transaction = this.storage.transaction?.bind(this.storage);
      if (!transaction) throw new RelayError('NOT_SUPPORTED', 'atomic storage unavailable');
      if (action === 'restore') {
        const version = await this.metadata(() => this.storage.get<IndexedFile>(`${ROOT}history:${id}:${body.revision}`));
        if (!version || version.deleted) throw new RelayError('NOT_FOUND', 'version not found');
        const content = await this.bucket.get(`vault-v1/${id}/${version.hash}`);
        if (!content) throw new RelayError('NOT_FOUND', 'version content unavailable');
        await content.body.cancel();
      }
      const files = await this.metadata(async () => {
        const pathCount = (await this.index(id)).byPath.size;
        return transaction(async storage => {
        const current = await storage.get<IndexedFile>(this.fileKey(id, body.path as string));
        if (!current || current.revision !== body.baseRevision) throw new RelayError('CONFLICT', 'file changed');
        if (current.movedTo) throw new RelayError('CONFLICT', 'file moved');
        const seqKey = `${ROOT}seq:${id}`;
        let revision = (await storage.get<number>(seqKey)) ?? 0;
        const commit = async (file: IndexedFile) => {
          file = { ...file, revision: ++revision, modifiedAt: Date.now() };
          await storage.put(`${ROOT}history:${id}:${revision}`, file);
          await storage.put(this.versionKey(id, file), file);
          await storage.put(this.fileKey(id, file.path), file);
          return file;
        };
        let changes: IndexedFile[];
        if (action === 'move') {
          if (current.deleted) throw new RelayError('NOT_FOUND', 'file not found');
          const target = await storage.get<IndexedFile>(this.fileKey(id, body.to as string));
          if (target && !target.deleted) throw new RelayError('CONFLICT', 'target exists');
          if (!target && pathCount >= 10000) throw new RelayError('QUOTA_EXCEEDED', 'vault file count exceeded');
          const stable = documentId(id, current);
          changes = [await commit({ ...current, documentId: stable, hash: null, size: 0, deleted: true, movedTo: body.to as string }),
            await commit({ ...current, documentId: stable, path: body.to as string, aliases: [...new Set([...(current.aliases ?? []), current.path])].filter(path => path !== body.to) })];
        } else {
          const historical = await storage.get<IndexedFile>(`${ROOT}history:${id}:${body.revision}`);
          if (!historical || historical.deleted || documentId(id, historical) !== documentId(id, current)) throw new RelayError('NOT_FOUND', 'version not found');
          changes = [await commit({ ...historical, path: current.path, documentId: documentId(id, current), aliases: current.aliases })];
        }
        await storage.put(seqKey, revision);
        return changes;
        });
      });
      this.indexes.delete(id);
      this.notify(id, files.at(-1)!.revision);
      return json({ files: files.map(file => publicFile(file, id)) });
    }
    if (['changes', 'index', 'watch'].includes(action) && request.method === 'GET') {
      const after = Number(url.searchParams.get('after') ?? 0);
      if (!Number.isSafeInteger(after) || after < 0)
        throw new RelayError('BAD_REQUEST', 'invalid cursor');
      if (action === 'watch') {
        const wait = Number(url.searchParams.get('wait') ?? 20000);
        if (!Number.isSafeInteger(wait) || wait < 0 || wait > 25000)
          throw new RelayError('BAD_REQUEST', 'invalid wait');
        return this.watch(request, id, after, wait);
      }
      const budget = url.searchParams.has('maxBytes')
        ? Number(url.searchParams.get('maxBytes'))
        : null;
      if (budget !== null && (!Number.isSafeInteger(budget) || budget < 131072 || budget > 1048576))
        throw new RelayError('BAD_REQUEST', 'invalid page budget');
      return this.page(id, after, action === 'index', action === 'index' ? budget : null);
    }
    if (action !== 'file' && action !== 'stat')
      throw new RelayError('NOT_FOUND', 'vault route not found');
    const path = url.searchParams.get('path');
    if (!isVaultPath(path)) throw new RelayError('BAD_REQUEST', 'invalid vault path');
    const fileKey = this.fileKey(id, path);
    if (request.method === 'GET') {
      const current = await this.metadata(() => this.storage.get<IndexedFile>(fileKey));
      if (action === 'stat') {
        if (!current) throw new RelayError('NOT_FOUND', 'file not found');
        return json(publicFile(current, id));
      }
      if (!current || current.deleted) throw new RelayError('NOT_FOUND', 'file not found');
      if (url.searchParams.get('revision') !== String(current.revision))
        throw new RelayError('CONFLICT', 'file changed');
      const encoding = url.searchParams.get('encoding');
      if (encoding === 'base64') {
        const offset = Number(url.searchParams.get('offset') ?? 0),
          length = Math.min(256 * 1024, current.size - offset);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > current.size)
          throw new RelayError('BAD_REQUEST', 'invalid offset');
        const object = length
          ? await this.bucket.get(`vault-v1/${id}/${current.hash}`, { range: { offset, length } })
          : null;
        if (length && !object) throw new RelayError('STATE_INVALID', 'file content missing');
        const bytes = object
          ? Buffer.from(await new Response(object.body).arrayBuffer())
          : Buffer.alloc(0);
        return json({
          data: bytes.subarray(0, length).toString('base64'),
          offset,
          next: offset + length,
          size: current.size,
        });
      }
      const object = await this.bucket.get(`vault-v1/${id}/${current.hash}`);
      if (!object) throw new RelayError('STATE_INVALID', 'file content missing');
      return new Response(object.body, {
        headers: {
          'content-type':
            encoding === 'text' && /\.(md|txt|json|ya?ml|csv)$/i.test(path)
              ? 'text/plain; charset=utf-8'
              : 'application/octet-stream',
          'content-length': String(current.size),
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }
    if (action !== 'file' || !['PUT', 'DELETE'].includes(request.method))
      throw new RelayError('NOT_FOUND', 'vault method not supported');
    const base = Number(request.headers.get('x-vault-base-revision'));
    if (!request.headers.has('x-vault-base-revision') || !Number.isSafeInteger(base) || base < 0)
      throw new RelayError('BAD_REQUEST', 'base revision required');
    const writing = request.method === 'PUT';
    let bytes: Uint8Array | undefined,
      hash: string | null = null,
      size = 0,
      prepared: IndexSummary | undefined;
    if (writing) {
      const declared = Number(request.headers.get('content-length') ?? VAULT_FILE_MAX_BYTES);
      if (!Number.isSafeInteger(declared) || declared < 0 || declared > VAULT_FILE_MAX_BYTES)
        throw new RelayError('PAYLOAD_TOO_LARGE', 'vault file too large');
      const release = await this.reserve(Math.max(131072, declared) * 2, request.signal);
      try {
        const reader = request.body?.getReader(),
          chunks: Uint8Array[] = [];
        if (reader)
          try {
            while (true) {
              const chunk = await reader.read();
              if (chunk.done) break;
              size += chunk.value.length;
              if (size > declared || size > VAULT_FILE_MAX_BYTES) {
                await reader.cancel();
                throw new RelayError('PAYLOAD_TOO_LARGE', 'vault file too large');
              }
              chunks.push(chunk.value);
            }
          } finally {
            reader.releaseLock();
          }
        bytes = Buffer.concat(chunks);
        chunks.length = 0;
        hash = createHash('sha256').update(bytes).digest('hex');
        if (/\.md$/i.test(path)) prepared = summary(bytes);
        // Immutable upload preparation is independent of the metadata commit queue.
        const previous = await this.metadata(() => this.storage.get<IndexedFile>(fileKey));
        if (previous && !previous.deleted && previous.hash === hash) {
          this.notify(id, previous.revision);
          return json(publicFile(previous, id));
        }
        if ((previous?.revision ?? 0) !== base) throw new RelayError('CONFLICT', 'file changed');
        if (
          !previous &&
          (await this.metadata(async () => (await this.index(id)).byPath.size)) >= 10000
        )
          throw new RelayError('QUOTA_EXCEEDED', 'vault file count exceeded');
        await this.bucket.put(`vault-v1/${id}/${hash}`, bytes);
        bytes = undefined;
      } finally {
        release();
      }
    }
    try {
      const file = await this.metadata(async () => {
        const current = await this.storage.get<IndexedFile>(fileKey);
        if (
          (writing && current && !current.deleted && current.hash === hash) ||
          (!writing && current?.deleted)
        ) {
          if (current) this.remember(id, current);
          return current!;
        }
        if ((current?.revision ?? 0) !== base) throw new RelayError('CONFLICT', 'file changed');
        if (!current) {
          if (!writing) throw new RelayError('NOT_FOUND', 'file not found');
          if ((await this.index(id)).byPath.size >= 10000)
            throw new RelayError('QUOTA_EXCEEDED', 'vault file count exceeded');
        }
        const seqKey = `${ROOT}seq:${id}`,
          revision = ((await this.storage.get<number>(seqKey)) ?? 0) + 1;
        await this.storage.put(seqKey, revision);
        const file: IndexedFile = {
          documentId: current && !current.movedTo ? documentId(id, current) : randomUUID(),
          ...(current?.aliases && !current.movedTo ? { aliases: current.aliases } : {}),
          path,
          revision,
          hash,
          size,
          deleted: !writing,
          modifiedAt: Date.now(),
          ...(prepared ? { summary: prepared } : {}),
        };
        await this.storage.put(`${ROOT}history:${id}:${revision}`, file);
        await this.storage.put(this.versionKey(id, file), file);
        await this.storage.put(fileKey, file);
        this.remember(id, file);
        return file;
      });
      this.notify(id, file.revision);
      return json(publicFile(file, id));
    } catch (error) {
      this.indexes.delete(id);
      for (const listener of this.waiters.get(id) ?? []) listener();
      throw error;
    }
  }
}
