import { hashSecret } from '../src/credentials';
import { RelayError } from '../src/errors';
import { parseStoredDevice, STATE_SCHEMA, type RelayStateFile, type RelayStorePort, type StoredDevice } from '../src/stateModel';
import type { ObjectStorage } from './runtime';

/** Durable Objects serializes this store's callers; flush precedes HTTP receipts. */
export class DurableRelayStore implements RelayStorePort {
  private revision = 0;
  private persistedRevision = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly devices = new Map<string, StoredDevice>();

  constructor(private readonly storage: ObjectStorage, private readonly state: RelayStateFile) {
    if (state.schema !== STATE_SCHEMA || !Array.isArray(state.devices)) throw new RelayError('STATE_INVALID', 'invalid relay state');
    for (const raw of state.devices) {
      const device = parseStoredDevice(raw, state.relayId, state.ownerPublicKey);
      if (!device || this.devices.has(device.deviceId)) throw new RelayError('STATE_INVALID', 'invalid device state');
      this.devices.set(device.deviceId, device);
    }
    if (this.list().filter(device => device.role === 'owner').length !== 1) throw new RelayError('STATE_INVALID', 'invalid owner state');
  }

  get relayId() { return this.state.relayId; }
  get relayName() { return this.state.name; }
  get ownerUserId() { return this.state.ownerUserId; }
  get ownerPublicKey() { return this.state.ownerPublicKey; }
  get mediaSigningKey() { return this.state.mediaSigningKey; }
  get(deviceId: string) { return this.devices.get(deviceId); }
  list() { return [...this.devices.values()]; }
  certificates() { return this.list().map(device => device.cert); }
  findByCredential(credential: string) {
    const hash = hashSecret(credential);
    return this.list().find(device => device.credentialHash === hash);
  }

  admitMember(input: Parameters<RelayStorePort['admitMember']>[0]): StoredDevice {
    const previous = this.get(input.deviceId);
    if (previous?.role === 'owner') throw new RelayError('FORBIDDEN', 'owner device cannot re-pair');
    const device: StoredDevice = {
      deviceId: input.deviceId, role: 'member', credentialHash: input.credentialHash, cert: input.cert,
      reportedName: input.reportedName, customName: previous?.customName ?? null,
      platform: input.platform, appVersion: input.appVersion, deviceInfo: previous?.deviceInfo ?? null,
      pairedAt: input.now, lastSeenAt: previous?.lastSeenAt ?? null,
    };
    this.devices.set(device.deviceId, device);
    this.revision += 1;
    return device;
  }

  remove(deviceId: string) {
    const device = this.get(deviceId);
    if (device) { this.devices.delete(deviceId); this.revision += 1; }
    return device;
  }

  update(deviceId: string, patch: Parameters<RelayStorePort['update']>[1]) {
    const device = this.get(deviceId);
    if (device) { Object.assign(device, patch); this.revision += 1; }
    return device;
  }

  flush(): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      if (this.revision === this.persistedRevision) return;
      const revision = this.revision;
      await this.storage.put('relay-state', structuredClone({ ...this.state, devices: this.list() }));
      this.persistedRevision = revision;
    });
    this.writes = write;
    return write;
  }
}
