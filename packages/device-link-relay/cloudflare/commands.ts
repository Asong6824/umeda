import { createHash, randomUUID } from 'node:crypto';
import {
  isUmedaCommandInput, UMEDA_COMMAND_MAX_BYTES, UMEDA_COMMAND_TTL_MS,
  type UmedaCommandInput, type UmedaCommandReceipt, type UmedaCommandClaim,
  type UmedaCommandSettlement,
} from '@cindy/device-link';
import { RelayError } from '../src/errors';
import type { ObjectStorage } from './runtime';

const PREFIX = 'umeda-command-v1:';
const RECEIVERS = 'umeda-command-receivers-v1';
const LEASE_MS = 60_000;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
interface Entry extends UmedaCommandReceipt {
  order: number;
  fingerprint: string;
  input?: UmedaCommandInput;
  leaseId?: string;
  leaseUntil?: number;
  retryAt?: number;
  attempted?: boolean;
}

/** DO storage owns receipt + payload before acknowledging a phone. Mutations are serialized. */
export class DurableCommands {
  private entries = new Map<string, Entry>();
  private receivers: Record<string, number> = {};
  private serial: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  constructor(private storage: ObjectStorage, private now = Date.now) {
    this.ready = Promise.all([
      storage.list<Entry>({ prefix: PREFIX }), storage.get<Record<string, number>>(RECEIVERS),
    ]).then(([entries, receivers]) => { this.entries = entries; this.receivers = receivers ?? {}; });
  }
  private key(source: string, client: string) {
    return PREFIX + createHash('sha256').update(JSON.stringify([source, client])).digest('hex');
  }
  private mutate<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.catch(() => undefined).then(() => this.ready).then(fn);
    this.serial = next;
    return next;
  }
  private receipt(e: Entry): UmedaCommandReceipt {
    const { clientId, sourceDeviceId, targetDeviceId, sessionId, state, createdAt, expiresAt, errorCode } = e;
    return { clientId, sourceDeviceId, targetDeviceId, sessionId, state, createdAt, expiresAt, ...(errorCode ? { errorCode } : {}) };
  }
  private async save(key: string, e: Entry) {
    await this.storage.put(key, e);
    this.entries.set(key, e);
  }
  private terminal(e: Entry, state: Entry['state'], errorCode?: string): Entry {
    const next = { ...e, state, errorCode };
    delete next.input; delete next.leaseId; delete next.leaseUntil; delete next.retryAt;
    return next;
  }
  private async sweepNow() {
    const now = this.now();
    for (const [key, e] of this.entries) {
      if (e.state !== 'queued' && now >= e.expiresAt + RETENTION_MS) {
        await this.storage.delete(key); this.entries.delete(key);
      } else if (e.state === 'queued' && !e.attempted && now >= e.expiresAt) {
        await this.save(key, this.terminal(e, 'expired', 'COMMAND_EXPIRED'));
      }
    }
  }
  supported(target: string): Promise<boolean> {
    return this.mutate(async () => Object.hasOwn(this.receivers, target));
  }
  submit(source: string, value: unknown): Promise<UmedaCommandReceipt> {
    return this.mutate(async () => {
      if (!isUmedaCommandInput(value)) throw new RelayError('BAD_REQUEST', 'invalid durable input');
      const input = structuredClone(value);
      const serialized = JSON.stringify(input);
      if (Buffer.byteLength(serialized) > UMEDA_COMMAND_MAX_BYTES) throw new RelayError('PAYLOAD_TOO_LARGE', 'durable input is too large');
      await this.sweepNow();
      const key = this.key(source, input.clientId);
      const fingerprint = createHash('sha256').update(serialized).digest('hex');
      const old = this.entries.get(key);
      if (old) {
        if (old.fingerprint !== fingerprint) throw new RelayError('CONFLICT', 'clientId already belongs to another input');
        return this.receipt(old);
      }
      if (!Object.hasOwn(this.receivers, input.targetDeviceId)) throw new RelayError('CONFLICT', 'COMMAND_RECEIVER_UNSUPPORTED');
      const pending = [...this.entries.values()].filter(e => e.state === 'queued');
      if (this.entries.size >= 4096 || pending.length >= 256
        || pending.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.input)), 0) + Buffer.byteLength(serialized) > 8 * 1024 * 1024) {
        throw new RelayError('RATE_LIMITED', 'durable inbox is full');
      }
      const now = this.now();
      const e: Entry = {
        order: Math.max(this.now(), ...[...this.entries.values()].map(e => e.order + 1)),
        clientId: input.clientId, sourceDeviceId: source, targetDeviceId: input.targetDeviceId,
        sessionId: input.sessionId, state: 'queued', createdAt: now,
        expiresAt: now + UMEDA_COMMAND_TTL_MS, fingerprint, input,
      };
      await this.save(key, e);
      return this.receipt(e);
    });
  }
  get(source: string, clientId: string): Promise<UmedaCommandReceipt | null> {
    return this.mutate(async () => { await this.sweepNow(); const e = this.entries.get(this.key(source, clientId)); return e ? this.receipt(e) : null; });
  }
  cancel(source: string, clientId: string): Promise<UmedaCommandReceipt | null> {
    return this.mutate(async () => {
      await this.sweepNow();
      const key = this.key(source, clientId), e = this.entries.get(key);
      if (!e) return null;
      // A claimed input may already be in the host's durable queue. Never promise its cancellation.
      if (e.state !== 'queued' || e.attempted) return this.receipt(e);
      const next = this.terminal(e, 'cancelled'); await this.save(key, next); return this.receipt(next);
    });
  }
  claim(target: string): Promise<UmedaCommandClaim | null> {
    return this.mutate(async () => {
      if (!Object.hasOwn(this.receivers, target)) {
        const next = { ...this.receivers, [target]: this.now() };
        await this.storage.put(RECEIVERS, next); this.receivers = next;
      }
      await this.sweepNow();
      const blocked = new Set<string>();
      for (const [key, e] of [...this.entries].sort((a, b) => a[1].order - b[1].order)) {
        if (e.targetDeviceId !== target || e.state !== 'queued') continue;
        if (blocked.has(e.sessionId)) continue;
        blocked.add(e.sessionId);
        if ((e.leaseUntil ?? 0) > this.now() || (e.retryAt ?? 0) > this.now()) continue;
        const leaseId = randomUUID();
        await this.save(key, { ...e, attempted: true, leaseId, leaseUntil: this.now() + LEASE_MS });
        return { ...e.input!, sourceDeviceId: e.sourceDeviceId, leaseId };
      }
      return null;
    });
  }
  settle(target: string, value: UmedaCommandSettlement): Promise<UmedaCommandReceipt> {
    return this.mutate(async () => {
      if (!value || typeof value.sourceDeviceId !== 'string' || typeof value.clientId !== 'string'
        || typeof value.leaseId !== 'string' || !['accepted', 'failed', 'retry'].includes(value.state)) {
        throw new RelayError('BAD_REQUEST', 'invalid durable input receipt');
      }
      const key = this.key(value.sourceDeviceId, value.clientId), e = this.entries.get(key);
      if (!e || e.targetDeviceId !== target) throw new RelayError('NOT_FOUND', 'durable input not found');
      if (e.state === 'accepted' && value.state === 'accepted') return this.receipt(e);
      if (e.state !== 'queued' || e.leaseId !== value.leaseId) throw new RelayError('CONFLICT', 'claim is no longer current');
      const code = typeof value.errorCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value.errorCode) ? value.errorCode : undefined;
      const next = value.state === 'retry'
        ? { ...e, leaseId: undefined, leaseUntil: undefined, retryAt: this.now() + 30_000 }
        : this.terminal(e, value.state, code);
      await this.save(key, next); return this.receipt(next);
    });
  }
  removeDevice(device: string): Promise<void> {
    return this.mutate(async () => {
      const receivers = { ...this.receivers }; delete receivers[device];
      await this.storage.put(RECEIVERS, receivers); this.receivers = receivers;
      for (const [key, e] of this.entries) if (e.state === 'queued' && (e.targetDeviceId === device || e.sourceDeviceId === device)) {
        await this.save(key, this.terminal(e, 'cancelled', 'DEVICE_REMOVED'));
      }
    });
  }
  sweep(): Promise<void> { return this.mutate(() => this.sweepNow()); }
  hasPending(target: string): Promise<boolean> {
    return this.mutate(async () => [...this.entries.values()].some(e => e.targetDeviceId === target && e.state === 'queued'));
  }
}
