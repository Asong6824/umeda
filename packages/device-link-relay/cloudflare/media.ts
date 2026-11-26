/** Small transient attachments without an R2 account. Wire format matches the Node relay. */
import { randomUUID } from 'node:crypto';
import { hmacHex, safeEqualHex } from '../src/credentials';
import { RelayError } from '../src/errors';
import type { ObjectStorage } from './runtime';

const PREFIX = '/api/device-link/relay/blob/';
const KEY = /^[0-9a-f-]{36}\.[a-z0-9]{1,16}$/;
const CHUNK = 128 * 1024;
export const EDGE_MEDIA_LIMITS = { maxObjectBytes: 8 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024 };
const TTL = 24 * 60 * 60_000;
const URL_TTL = 60 * 60_000;
interface Meta { size: number; contentType: string; expiresAt: number; complete: boolean }

export class DurableMedia {
  constructor(private readonly storage: ObjectStorage, private readonly signingKey: string) {}

  private sign(op: string, key: string, exp: number) { return hmacHex(this.signingKey, `${op}\n${key}\n${exp}`); }
  private url(base: string, op: string, key: string, exp: number) {
    return `${base}${PREFIX}${key}?${new URLSearchParams({ op, exp: String(exp), sig: this.sign(op, key, exp) })}`;
  }
  async stats() {
    let usedBytes = 0, reservedBytes = 0;
    for (const meta of (await this.storage.list<Meta>({ prefix: 'media:meta:' })).values()) {
      if (meta.expiresAt < Date.now()) continue;
      if (meta.complete) usedBytes += meta.size;
      else reservedBytes += meta.size;
    }
    return { usedBytes, reservedBytes };
  }
  async presignPut(input: Record<string, unknown>, base: string) {
    if (input.sharedTaskId !== undefined) throw new RelayError('NOT_SUPPORTED', 'shared media is not supported');
    const { size, ext, contentType } = input;
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || typeof ext !== 'string' || !/^[a-z0-9]{1,16}$/.test(ext)
      || typeof contentType !== 'string' || !contentType.trim() || contentType.length > 255 || /[\r\n]/.test(contentType)) {
      throw new RelayError('BAD_REQUEST', 'invalid media declaration');
    }
    if (size > EDGE_MEDIA_LIMITS.maxObjectBytes) throw new RelayError('PAYLOAD_TOO_LARGE', 'Workers relay supports attachments up to 8 MiB');
    // This whole operation is serialized with storage's input gate, including reservations.
    const stats = await this.stats();
    if (stats.usedBytes + stats.reservedBytes + size > EDGE_MEDIA_LIMITS.maxTotalBytes) throw new RelayError('QUOTA_EXCEEDED', 'media quota exceeded');
    const key = `${randomUUID()}.${ext}`;
    const exp = Date.now() + URL_TTL;
    await this.storage.put<Meta>(`media:meta:${key}`, { size, contentType: contentType.trim(), expiresAt: exp, complete: false });
    return { putUrl: this.url(base, 'put', key, exp), key, expiresAt: new Date(exp).toISOString() };
  }
  async presignGet(key: unknown, base: string) {
    const meta = await this.meta(key);
    if (!meta.complete) throw new RelayError('NOT_FOUND', 'media object not found');
    const exp = Math.min(Date.now() + URL_TTL, meta.expiresAt);
    return { getUrl: this.url(base, 'get', key as string, exp), expiresAt: new Date(exp).toISOString() };
  }
  private async meta(key: unknown) {
    if (typeof key !== 'string' || !KEY.test(key)) throw new RelayError('BAD_REQUEST', 'invalid media key');
    const meta = await this.storage.get<Meta>(`media:meta:${key}`);
    if (!meta || meta.expiresAt < Date.now()) throw new RelayError('NOT_FOUND', 'media object not found');
    return meta;
  }
  async delete(key: unknown) {
    if (typeof key !== 'string' || !KEY.test(key)) throw new RelayError('BAD_REQUEST', 'invalid media key');
    if (this.uploads.has(key)) this.removedDuringUpload.add(key);
    const chunks = await this.storage.list({ prefix: `media:body:${key}:` });
    await this.storage.delete([`media:meta:${key}`, ...chunks.keys()]);
  }
  async sweep() {
    for (const [key, meta] of await this.storage.list<Meta>({ prefix: 'media:meta:' })) {
      if (meta.expiresAt < Date.now()) await this.delete(key.slice('media:meta:'.length));
    }
  }
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const key = url.pathname.slice(PREFIX.length);
    const op = request.method === 'PUT' ? 'put' : ['GET', 'HEAD'].includes(request.method) ? 'get' : null;
    const exp = Number(url.searchParams.get('exp'));
    if (!op || !KEY.test(key) || url.searchParams.get('op') !== op || !Number.isSafeInteger(exp) || exp < Date.now()
      || !safeEqualHex(url.searchParams.get('sig') ?? '', this.sign(op, key, exp))) throw new RelayError('FORBIDDEN', 'invalid or expired media link');
    const meta = await this.meta(key);
    if (op === 'put') {
      if (meta.complete || this.uploads.has(key)) throw new RelayError('CONFLICT', 'upload already used');
      this.uploads.add(key);
      const reader = request.body?.getReader();
      let size = 0, chunkIndex = 0;
      try {
        if (!reader) throw new RelayError('BAD_REQUEST', 'empty upload');
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (this.removedDuringUpload.has(key)) throw new RelayError('CONFLICT', 'upload was deleted');
          size += value.byteLength;
          if (size > meta.size) throw new RelayError('PAYLOAD_TOO_LARGE', 'upload exceeds declared size');
          for (let offset = 0; offset < value.byteLength; offset += CHUNK) {
            await this.storage.put(`media:body:${key}:${String(chunkIndex++).padStart(6, '0')}`, value.slice(offset, offset + CHUNK));
          }
        }
        if (this.removedDuringUpload.has(key)) throw new RelayError('CONFLICT', 'upload was deleted');
        if (!size) throw new RelayError('BAD_REQUEST', 'empty upload');
        await this.storage.put<Meta>(`media:meta:${key}`, { ...meta, size, complete: true, expiresAt: Date.now() + TTL });
        return new Response(null, { status: 200 });
      } catch (error) {
        await reader?.cancel().catch(() => undefined);
        await this.delete(key);
        throw error;
      } finally { reader?.releaseLock(); this.uploads.delete(key); this.removedDuringUpload.delete(key); }
    }
    if (!meta.complete) throw new RelayError('NOT_FOUND', 'media object not found');
    // Bounded by 8 MiB; copying here keeps response lifetime independent of storage mutation.
    const pieces = await this.storage.list<Uint8Array>({ prefix: `media:body:${key}:` });
    const body = new Uint8Array(meta.size);
    let offset = 0;
    for (const piece of pieces.values()) { body.set(piece, offset); offset += piece.byteLength; }
    if (offset !== meta.size) throw new RelayError('INTERNAL', 'incomplete media object');
    const headers: Record<string, string> = { 'content-type': meta.contentType, 'cache-control': 'private, no-store', 'accept-ranges': 'bytes' };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    let start = 0, end = meta.size - 1, status = 200;
    if (range && (range[1] || range[2])) {
      start = range[1] ? Number(range[1]) : Math.max(0, meta.size - Number(range[2]));
      end = range[1] && range[2] ? Math.min(Number(range[2]), end) : end;
      if (start > end || start >= meta.size || (!range[1] && Number(range[2]) === 0)) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${meta.size}` } });
      status = 206; headers['content-range'] = `bytes ${start}-${end}/${meta.size}`;
    }
    headers['content-length'] = String(end - start + 1);
    return new Response(request.method === 'HEAD' ? null : body.slice(start, end + 1), { status, headers });
  }
  private readonly uploads = new Set<string>();
  private readonly removedDuringUpload = new Set<string>();
}
