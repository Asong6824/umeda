import { WORK_CHANGE_NOTICE, WORK_SYNC_FEATURE } from '@cindy/maker-shared/work-replication';
import { randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { DEFAULT_HUB_LIMITS, Hub, type HubDevice } from '../src/hub';
import { DEVICE_ID_PATTERN, normalizeName } from '../src/stateModel';
import { RelayError } from '../src/errors';
import { RELAY_VERSION } from '../src/version';
import { DurableMedia } from './media';
import { DurableSocket } from './socket';
import { readJson } from './requestJson';
import { DurableCommands } from './commands';
import { CloudVault, type VaultBucket } from './vault';
import { VAULT_SYNC_FEATURE, VAULT_INDEX_FEATURE, VAULT_BATCH_FEATURE, VAULT_NOTIFY_FEATURE, VAULT_LIBRARY_FEATURE, VAULT_CHANGE_NOTICE, VAULT_SYNC_PATH } from '@cindy/device-link';
import { UMEDA_COMMAND_FEATURE, UMEDA_COMMAND_NOTICE, UMEDA_COMMAND_PATH, type UmedaCommandSettlement } from '@cindy/device-link';
import type { EdgeSocket, ObjectContext } from './runtime';

const P = '/api/device-link';
const KEY = 'umeda-open-state-v1';
interface OpenState { relayId: string; name: string; mediaSigningKey: string; devices: HubDevice[] }
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

/** Public personal relay, explicitly selected by UMEDA_AUTH_MODE=none.
 * Device IDs are routing labels supplied by callers, never authentication.
 * The signed Node relay and its state remain separate and untouched.
 */
export class OpenRelay {
  private state!: OpenState;
  private readonly devices = new Map<string, HubDevice>();
  private readonly sockets = new Map<EdgeSocket, DurableSocket>();
  private hub!: Hub;
  private media!: DurableMedia;
  private readonly ready: Promise<void>;
  private readonly commands: DurableCommands;
  private readonly vault?: CloudVault;
  private revision = 1;
  private persistedRevision = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: ObjectContext, bucket?: VaultBucket, private readonly workSync = false) {
    this.commands = new DurableCommands(ctx.storage);
    if (bucket) this.vault = new CloudVault(ctx.storage, bucket, (vaultId, revision) => this.notifyVault(vaultId, revision));
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<OpenState>(KEY);
      // Preserve names and device IDs when upgrading an already deployed relay.
      // No credential, certificate or owner key is copied into the public state.
      const old = stored ? undefined : await ctx.storage.get<OpenState>('relay-state');
      this.state = stored ?? {
        relayId: old?.relayId ?? randomUUID(), name: old?.name ?? 'Umeda',
        mediaSigningKey: old?.mediaSigningKey ?? randomBytes(32).toString('base64url'),
        devices: (old?.devices ?? []).map(d => ({
          deviceId: d.deviceId, reportedName: d.reportedName, customName: d.customName,
          role: d.role, platform: d.platform, appVersion: d.appVersion,
          deviceInfo: d.deviceInfo, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt,
        })),
      };
      for (const device of this.state.devices) this.devices.set(device.deviceId, device);
      this.hub = new Hub({ get: id => this.devices.get(id), update: (id, patch) => {
        const device = this.devices.get(id);
        if (device) { Object.assign(device, patch); this.revision++; }
        return device;
      } }, 'local-v1', Date.now, { info() {}, warn() {}, error() {} }, { ...DEFAULT_HUB_LIMITS, hibernating: true });
      this.media = new DurableMedia(ctx.storage, this.state.mediaSigningKey);
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment();
        const device = attachment && this.devices.get(attachment.connection.deviceId);
        if (!device || socket.readyState !== 1) { socket.close(1001, 'reconnect'); continue; }
        const adapter = new DurableSocket(socket);
        this.sockets.set(socket, adapter);
        this.hub.attach(adapter, device, attachment!.connection);
      }
      await this.flush();
    });
  }

  private async flush(): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      if (this.revision === this.persistedRevision) return;
      const revision = this.revision;
      await this.ctx.storage.put(KEY, structuredClone({ ...this.state, devices: [...this.devices.values()] }));
      this.persistedRevision = revision;
    });
    this.writes = write;
    await write;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    try {
      const response = await this.handle(request);
      await this.flush();
      await this.scheduleAlarm();
      return response;
    } catch (error) {
      const failure = error instanceof RelayError ? error : new RelayError('INTERNAL', 'internal relay error');
      return json({ error: { code: failure.code, message: failure.message } }, failure.status);
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), route = url.pathname, method = request.method;
    if (route === '/internal/work-changed' && method === 'POST' && this.workSync) {
      for (const socket of this.ctx.getWebSockets()) {
        const connection = socket.deserializeAttachment()?.connection;
        if (socket.readyState !== 1 || !connection?.ready) continue;
        try { socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', src: connection.deviceId, dst: connection.deviceId, payload: { channel: WORK_CHANGE_NOTICE, payload: null } })); } catch { /* Cursor repair handles a missed hint. */ }
      }
      return new Response(null, { status: 204 });
    }
    const version = `${RELAY_VERSION}-umeda.8`;
    if (method === 'GET' && ['/', '/health'].includes(route)) return json({
      service: 'umeda-relay', version, initialized: true, protocolVersion: PROTOCOL_VERSION, authMode: 'none',
    });
    if (route.startsWith(`${P}/relay/blob/`)) return this.media.handle(request);
    if (method === 'GET' && route === `${P}/relay/info`) return json({
      relayId: this.state.relayId, name: this.state.name, protocolVersion: PROTOCOL_VERSION,
      relayVersion: version, authMode: 'none', features: [UMEDA_COMMAND_FEATURE, ...(this.workSync ? [WORK_SYNC_FEATURE] : []), ...(this.vault ? [VAULT_SYNC_FEATURE, VAULT_INDEX_FEATURE, VAULT_BATCH_FEATURE, VAULT_NOTIFY_FEATURE, VAULT_LIBRARY_FEATURE] : [])],
    });
    if (route === VAULT_SYNC_PATH || route.startsWith(`${VAULT_SYNC_PATH}/`)) {
      if (!this.vault) throw new RelayError('NOT_SUPPORTED', 'vault storage not configured');
      return this.vault.handle(request);
    }
    const selfId = request.headers.get('x-umeda-device-id') ?? url.searchParams.get('deviceId') ?? '';
    if (route === UMEDA_COMMAND_PATH || route.startsWith(`${UMEDA_COMMAND_PATH}/`)) {
      if (!DEVICE_ID_PATTERN.test(selfId) || !this.devices.has(selfId)) throw new RelayError('BAD_REQUEST', 'known device routing label required');
      if (route === UMEDA_COMMAND_PATH && method === 'POST') {
        const input = await readJson(request);
        if (typeof input.targetDeviceId !== 'string' || !this.devices.has(input.targetDeviceId)) throw new RelayError('NOT_FOUND', 'target device not found');
        const receipt = await this.commands.submit(selfId, input);
        this.notifyCommands(receipt.targetDeviceId);
        return json({ receipt }, 202);
      }
      if (route === `${UMEDA_COMMAND_PATH}/capabilities` && method === 'GET') {
        return json({ supported: await this.commands.supported(url.searchParams.get('targetDeviceId') ?? '') });
      }
      if (route === `${UMEDA_COMMAND_PATH}/claim` && method === 'POST') {
        const command = await this.commands.claim(selfId);
        const source = command && this.devices.get(command.sourceDeviceId);
        return json({ command: command ? { ...command, sourcePlatform: source?.platform ?? null,
          sourceName: source?.customName ?? source?.reportedName ?? null } : null,
          ...(!command && await this.commands.hasPending(selfId) ? { pending: true } : {}) });
      }
      if (route === `${UMEDA_COMMAND_PATH}/settle` && method === 'POST') {
        const receipt = await this.commands.settle(selfId, await readJson(request) as unknown as UmedaCommandSettlement);
        this.notifyCommands(receipt.sourceDeviceId);
        return json({ receipt });
      }
      const clientId = decodeURIComponent(route.slice(UMEDA_COMMAND_PATH.length + 1));
      if (clientId && (method === 'GET' || method === 'DELETE')) {
        const receipt = method === 'DELETE' ? await this.commands.cancel(selfId, clientId) : await this.commands.get(selfId, clientId);
        if (!receipt) throw new RelayError('NOT_FOUND', 'durable input not found');
        return json({ receipt });
      }
      throw new RelayError('NOT_FOUND', 'durable input route not found');
    }
    if (method === 'GET' && route === `${P}/ws`) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      if (!DEVICE_ID_PATTERN.test(selfId)) throw new RelayError('BAD_REQUEST', 'deviceId routing label required');
      if (this.ctx.getWebSockets().length >= DEFAULT_HUB_LIMITS.maxConnections) throw new RelayError('RATE_LIMITED', 'relay connection limit reached');
      let device = this.devices.get(selfId);
      if (!device) {
        if (this.devices.size >= DEFAULT_HUB_LIMITS.maxConnections) throw new RelayError('RATE_LIMITED', 'relay device capacity reached');
        device = { deviceId: selfId, role: 'member', reportedName: selfId, customName: null,
          platform: null, appVersion: null, deviceInfo: null, pairedAt: Date.now(), lastSeenAt: null };
        this.devices.set(selfId, device);
        this.revision++;
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const adapter = new DurableSocket(pair[1]);
      this.sockets.set(pair[1], adapter);
      this.hub.attach(adapter, device);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    if (method === 'GET' && route === `${P}/devices`) return json({ devices: [...this.devices.values()].map(d => this.hub.deviceView(d, selfId)) });
    const match = /^\/api\/device-link\/devices\/([^/]+)$/.exec(route);
    if (match && ['PATCH', 'DELETE'].includes(method)) {
      const id = decodeURIComponent(match[1]), device = this.devices.get(id);
      if (!device) throw new RelayError('NOT_FOUND', 'device not found');
      if (method === 'DELETE') {
        await this.commands.removeDevice(id);
        this.devices.delete(id); this.revision++; this.hub.disconnectDevice(device, 4410, 'device removed');
        return json({ deleted: true });
      }
      const name = normalizeName((await readJson(request)).name);
      if (!name) throw new RelayError('BAD_REQUEST', 'invalid device name');
      device.customName = name; this.revision++; this.hub.announce(device);
      return json({ device: this.hub.deviceView(device, selfId) });
    }
    if (method === 'POST' && route === `${P}/media/presign-put`) return json(await this.media.presignPut(await readJson(request), url.origin));
    if (method === 'POST' && route === `${P}/media/presign-get`) return json(await this.media.presignGet((await readJson(request)).key, url.origin));
    if (method === 'DELETE' && route === `${P}/media`) { await this.media.delete((await readJson(request)).key); return json({ deleted: true }); }
    if (route === `${P}/push-token` && ['PUT', 'DELETE'].includes(method)) return new Response(null, { status: 204 });
    if (method === 'GET' && route === `${P}/provider-shares`) return json({ shares: [] });
    throw new RelayError('NOT_FOUND', 'route is not available on this relay');
  }

  async webSocketMessage(socket: EdgeSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const deviceId = socket.deserializeAttachment()?.connection.deviceId;
    if (!deviceId || !this.devices.has(deviceId)) { socket.close(4410, 'device removed'); return; }
    this.sockets.get(socket)?.emit('message', typeof message === 'string' ? Buffer.from(message) : Buffer.from(message), typeof message !== 'string');
    await this.flush(); await this.scheduleAlarm();
  }
  async webSocketClose(socket: EdgeSocket): Promise<void> {
    await this.ready;
    this.sockets.get(socket)?.emit('close'); this.sockets.delete(socket);
    await this.flush(); await this.scheduleAlarm();
  }
  async alarm(): Promise<void> {
    await this.ready;
    this.hub.closeIdle(); await this.media.sweep(); await this.commands.sweep(); await this.flush(); await this.scheduleAlarm();
  }
  private notifyVault(vaultId: string, revision: number) {
    for (const socket of this.ctx.getWebSockets()) {
      const connection = socket.deserializeAttachment()?.connection;
      if (socket.readyState !== 1 || !connection?.ready) continue;
      try { socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', src: connection.deviceId, dst: connection.deviceId,
        payload: { channel: VAULT_CHANGE_NOTICE, payload: { vaultId, revision } } })); } catch { /* Persistent cursors repair a missed hint. */ }
    }
  }
  private notifyCommands(deviceId: string) {
    // Optional, payload-free hint on the existing push channel. Reconnect/periodic reads repair loss.
    for (const socket of this.ctx.getWebSockets()) {
      const connection = socket.deserializeAttachment()?.connection;
      if (socket.readyState !== 1 || !connection?.ready || connection.deviceId !== deviceId) continue;
      try { socket.send(JSON.stringify({ v: PROTOCOL_VERSION, kind: 'push', src: deviceId, dst: deviceId,
        payload: { channel: UMEDA_COMMAND_NOTICE, payload: null } })); } catch { /* durable inbox remains authoritative */ }
    }
  }
  private async scheduleAlarm(): Promise<void> {
    const next = Math.max(Date.now() + 1_000, Math.min(this.hub.nextDeadline() ?? Infinity, Date.now() + 3_600_000));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next || current <= Date.now()) await this.ctx.storage.setAlarm(next);
  }
}
