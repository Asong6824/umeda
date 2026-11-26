import { Buffer } from 'node:buffer';
import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { verifyRelayInitialization, type RelayInitialization } from '@cindy/device-link';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { isRelayPublicKey } from '@cindy/device-link/relay-auth';
import { parseRelayAuthorization } from '../src/credentials';
import { RelayError } from '../src/errors';
import { CLOSE_DEVICE_REMOVED, DEFAULT_HUB_LIMITS, Hub } from '../src/hub';
import { Pairing } from '../src/pairing';
import { createRelayState, normalizeName, type RelayStateFile, type StoredDevice } from '../src/stateModel';
import { RELAY_VERSION } from '../src/version';
import { DurableRelayStore } from './store';
import { DurableSocket } from './socket';
import { DurableMedia } from './media';
import type { EdgeSocket, ObjectContext, RelayEnvironment } from './runtime';
import { OpenRelay } from './openRelay';
import { readJson } from './requestJson';

export { UmedaWork } from './work';

const PREFIX = '/api/device-link';
const VERSION = `${RELAY_VERSION}-umeda.1`;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

/** One named object owns the private relay: all devices reach the same coordinator. */
export default {
  fetch(request: Request, env: RelayEnvironment): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/internal/')) return Promise.resolve(new Response(null, { status: 404 }));
    if (new URL(request.url).pathname.startsWith('/api/work/')) {
      if (env.UMEDA_AUTH_MODE !== 'none' || !env.UMEDA_WORK) return Promise.resolve(Response.json({ error: 'WORK_SYNC_UNAVAILABLE' }, { status: 404 }));
      return env.UMEDA_WORK.get(env.UMEDA_WORK.idFromName('work-v1')).fetch(request);
    }
    return env.UMEDA_RELAY.get(env.UMEDA_RELAY.idFromName('private-relay-v1')).fetch(request);
  },
};

export class UmedaRelay extends DurableObject<RelayEnvironment> {
  private store?: DurableRelayStore;
  private hub?: Hub;
  private pairing?: Pairing;
  private media?: DurableMedia;
  private pairingSnapshot = '';
  private initializing: Promise<void> | null = null;
  private readonly sockets = new Map<EdgeSocket, DurableSocket>();
  private readonly ready: Promise<void>;
  private readonly open?: OpenRelay;

  constructor(private readonly ctx: ObjectContext, private readonly env: RelayEnvironment) {
    super(ctx, env);
    if (env.UMEDA_AUTH_MODE === 'none') {
      this.open = new OpenRelay(ctx, env.UMEDA_VAULT, !!env.UMEDA_WORK);
      this.ready = Promise.resolve();
      return;
    }
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const state = await ctx.storage.get<RelayStateFile>('relay-state');
      if (!state) return;
      this.install(state);
      const pairing = await ctx.storage.get<ReturnType<Pairing['snapshot']>>('pairing');
      if (pairing) this.pairing!.restore(pairing);
      this.pairingSnapshot = JSON.stringify(this.pairing!.snapshot());
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment();
        const device = attachment && this.store!.get(attachment.connection.deviceId);
        if (!device || device.credentialHash !== attachment!.credentialHash) {
          socket.close(CLOSE_DEVICE_REMOVED, 'device credential was revoked');
          continue;
        }
        if (socket.readyState !== 1) continue;
        const adapter = new DurableSocket(socket, attachment!.credentialHash);
        this.sockets.set(socket, adapter);
        this.hub!.attach(adapter, device, attachment!.connection);
      }
    });
  }

  private install(state: RelayStateFile): void {
    this.store = new DurableRelayStore(this.ctx.storage, state);
    this.hub = new Hub(this.store, state.ownerUserId, Date.now, {
      info() {}, warn() {}, error() {},
    }, { ...DEFAULT_HUB_LIMITS, hibernating: true });
    this.pairing = new Pairing(this.store, Date.now, device => {
      // Re-pairing rotates the credential. An already-open old socket must lose access too.
      this.hub!.disconnectDevice(device, CLOSE_DEVICE_REMOVED, 'device credential replaced');
      this.hub!.announce(device);
    });
    this.media = new DurableMedia(this.ctx.storage, state.mediaSigningKey);
  }

  async fetch(request: Request): Promise<Response> {
    if (this.open) return this.open.fetch(request);
    await this.ready;
    try {
      const response = await this.handle(request);
      await this.store?.flush();
      await this.flushPairing();
      await this.scheduleAlarm();
      return response;
    } catch (error) {
      await this.flushPairing().catch(() => undefined);
      const failure = error instanceof RelayError ? error : new RelayError('INTERNAL', 'internal relay error');
      return json({ error: { code: failure.code, message: failure.message } }, failure.status);
    }
  }

  private async flushPairing(): Promise<void> {
    if (!this.pairing) return;
    const snapshot = this.pairing.snapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized === this.pairingSnapshot) return;
    await this.ctx.storage.put('pairing', snapshot);
    this.pairingSnapshot = serialized;
  }

  private authenticate(request: Request, ownerOnly = false): StoredDevice {
    const credential = parseRelayAuthorization(request.headers.get('authorization') ?? undefined);
    const device = credential && this.store?.findByCredential(credential);
    if (!device) throw new RelayError('RELAY_CREDENTIAL_INVALID', 'missing or invalid relay credential');
    if (ownerOnly && device.role !== 'owner') throw new RelayError('FORBIDDEN', 'only the owner device can manage this relay');
    return device;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = url.pathname;
    const method = request.method;
    if (method === 'GET' && (route === '/' || route === '/health')) {
      return json({ service: 'umeda-relay', version: VERSION, initialized: Boolean(this.store), protocolVersion: PROTOCOL_VERSION });
    }
    if (method === 'POST' && route === `${PREFIX}/relay/initialize`) {
      const body = await readJson(request);
      const pinned = this.env.UMEDA_OWNER_PUBLIC_KEY;
      if (!pinned || !isRelayPublicKey(pinned)) throw new RelayError('NOT_INITIALIZED', 'configure the owner public key before initialization');
      let state: RelayStateFile;
      try { state = createRelayState(body as unknown as RelayInitialization); }
      catch { throw new RelayError('BAD_REQUEST', 'invalid relay initialization'); }
      if (state.ownerUserId !== 'local-v1' || !verifyRelayInitialization(nodeRelayAuthCrypto, pinned,
        body as unknown as RelayInitialization, body.proof)) {
        throw new RelayError('FORBIDDEN', 'initialization requires the configured owner signature');
      }
      if (this.store) {
        if (this.store.relayId !== state.relayId || this.store.ownerPublicKey !== pinned
          || this.store.get(state.devices[0].deviceId)?.credentialHash !== state.devices[0].credentialHash) {
          throw new RelayError('ALREADY_INITIALIZED', 'relay already belongs to another identity');
        }
        return json({ relayId: this.store.relayId });
      }
      if (this.initializing) { await this.initializing; throw new RelayError('CONFLICT', 'initialization is complete; retry the signed request'); }
      const initializing = this.ctx.storage.put('relay-state', state).then(() => { this.install(state); });
      this.initializing = initializing;
      try { await initializing; } finally { this.initializing = null; }
      return json({ relayId: state.relayId }, 201);
    }
    if (!this.store || !this.hub || !this.pairing || !this.media) throw new RelayError('NOT_INITIALIZED', 'relay is not initialized');
    if (route.startsWith(`${PREFIX}/relay/blob/`)) return this.media.handle(request);
    if (method === 'GET' && route === `${PREFIX}/relay/info`) return json({
      relayId: this.store.relayId, name: this.store.relayName, protocolVersion: PROTOCOL_VERSION,
      relayVersion: VERSION, ownerPublicKey: this.store.ownerPublicKey,
      features: ['pairing-v1', 'device-signatures-v1'],
    });
    if (method === 'POST' && route === `${PREFIX}/relay/pair`) {
      return json(this.pairing.submit(await readJson(request), request.headers.get('cf-connecting-ip') ?? 'unknown'));
    }
    const poll = /^\/api\/device-link\/relay\/pair\/([0-9a-f-]{36})$/.exec(route);
    if (method === 'GET' && poll) {
      // Match the existing long poll contract; only the short pairing flow stays awake.
      const wait = Math.min(25_000, Math.max(0, url.searchParams.has('wait') ? (Number(url.searchParams.get('wait')) || 0) * 1000 : 20_000));
      return json(await this.pairing.poll(poll[1], request.headers.get('x-cindy-relay-poll-token'), wait));
    }
    const self = this.authenticate(request, route.startsWith(`${PREFIX}/relay/admin/`));
    if (method === 'GET' && route === `${PREFIX}/ws`) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      if (this.ctx.getWebSockets().length >= DEFAULT_HUB_LIMITS.maxConnections) throw new RelayError('RATE_LIMITED', 'relay connection limit reached');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const adapter = new DurableSocket(pair[1], self.credentialHash);
      this.sockets.set(pair[1], adapter);
      this.hub.attach(adapter, self);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    if (method === 'GET' && route === `${PREFIX}/devices`) return json({ devices: this.store.list().map(device => this.hub!.deviceView(device, self.deviceId)) });
    const deviceRoute = /^\/api\/device-link\/devices\/([^/]+)$/.exec(route);
    if (deviceRoute && (method === 'PATCH' || method === 'DELETE')) {
      const id = decodeURIComponent(deviceRoute[1]);
      if (self.role !== 'owner' && self.deviceId !== id) throw new RelayError('FORBIDDEN', 'cannot manage another device');
      const device = this.store.get(id);
      if (!device) throw new RelayError('NOT_FOUND', 'device not found');
      if (method === 'DELETE') {
        if (device.role === 'owner') throw new RelayError('FORBIDDEN', 'cannot remove the owner');
        this.store.remove(id);
        this.hub.disconnectDevice(device, CLOSE_DEVICE_REMOVED, 'device removed');
        return json({ deleted: true });
      }
      const body = await readJson(request);
      const name = normalizeName(body.name);
      if (!name) throw new RelayError('BAD_REQUEST', 'invalid device name');
      this.hub.announce(this.store.update(id, { customName: name })!);
      return json({ device: this.hub.deviceView(this.store.get(id)!, self.deviceId) });
    }
    if (method === 'GET' && route === `${PREFIX}/relay/certs`) return json({ ownerPublicKey: this.store.ownerPublicKey, certs: this.store.certificates() });
    if (method === 'POST' && route === `${PREFIX}/relay/admin/join-codes`) return json(this.pairing.createJoinCode());
    if (method === 'GET' && route === `${PREFIX}/relay/admin/pair-requests`) return json({ requests: this.pairing.listPending() });
    const decision = /^\/api\/device-link\/relay\/admin\/pair-requests\/([0-9a-f-]{36})\/(approve|reject)$/.exec(route);
    if (method === 'POST' && decision) {
      const approve = decision[2] === 'approve';
      this.pairing.decide(decision[1], approve, approve ? (await readJson(request)).cert : undefined);
      return json({ requestId: decision[1], status: approve ? 'approved' : 'rejected' });
    }
    if (method === 'GET' && route === `${PREFIX}/relay/admin/status`) return json({
      relayId: this.store.relayId, name: this.store.relayName, relayVersion: VERSION,
      protocolVersion: PROTOCOL_VERSION, devices: this.store.list().length, online: this.hub.onlineCount,
      media: await this.media.stats(), tls: 'certificate', certificateExpiresAt: null,
    });
    if (method === 'POST' && route === `${PREFIX}/media/presign-put`) return json(await this.media.presignPut(await readJson(request), url.origin));
    if (method === 'POST' && route === `${PREFIX}/media/presign-get`) return json(await this.media.presignGet((await readJson(request)).key, url.origin));
    if (method === 'DELETE' && route === `${PREFIX}/media`) { await this.media.delete((await readJson(request)).key); return json({ deleted: true }); }
    if (route === `${PREFIX}/push-token` && (method === 'PUT' || method === 'DELETE')) return new Response(null, { status: 204 });
    if (method === 'GET' && route === `${PREFIX}/provider-shares`) return json({ shares: [] });
    throw new RelayError('NOT_FOUND', 'route is not available on this relay');
  }

  async webSocketMessage(socket: EdgeSocket, message: string | ArrayBuffer): Promise<void> {
    if (this.open) return this.open.webSocketMessage(socket, message);
    await this.ready;
    const adapter = this.sockets.get(socket);
    const attachment = socket.deserializeAttachment();
    const device = attachment && this.store?.get(attachment.connection.deviceId);
    if (!adapter || !device || device.credentialHash !== attachment?.credentialHash) {
      socket.close(CLOSE_DEVICE_REMOVED, 'device credential was revoked'); return;
    }
    adapter.emit('message', typeof message === 'string' ? Buffer.from(message) : Buffer.from(message), typeof message !== 'string');
    await this.store?.flush();
    await this.scheduleAlarm();
  }

  async webSocketClose(socket: EdgeSocket): Promise<void> {
    if (this.open) return this.open.webSocketClose(socket);
    await this.ready;
    this.sockets.get(socket)?.emit('close');
    this.sockets.delete(socket);
    await this.store?.flush();
    await this.scheduleAlarm();
  }

  async webSocketError(socket: EdgeSocket): Promise<void> { socket.close(1011, 'connection failed'); await this.webSocketClose(socket); }

  async alarm(): Promise<void> {
    if (this.open) return this.open.alarm();
    await this.ready;
    this.hub?.closeIdle();
    await this.media?.sweep();
    await this.store?.flush();
    await this.scheduleAlarm();
  }

  private async scheduleAlarm(): Promise<void> {
    const deadline = this.hub?.nextDeadline();
    // Periodic cleanup is an alarm, never setInterval (which prevents hibernation).
    const next = Math.max(Date.now() + 1_000, Math.min(deadline ?? Infinity, Date.now() + 60 * 60_000));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next || current <= Date.now()) await this.ctx.storage.setAlarm(next);
  }
}
