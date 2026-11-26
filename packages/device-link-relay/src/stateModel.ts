/** Portable relay identity and validation; no filesystem or Electron dependency. */
import type { DeviceInfo } from '@cindy/device-link-protocol';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { isRelayPublicKey, verifyRelayDeviceCert, type RelayDeviceCert } from '@cindy/device-link/relay-auth';
import { createSecret, isSha256Hex } from './credentials';
import { RelayError } from './errors';
export const STATE_SCHEMA = 2;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const RELAY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_NAME_LENGTH = 64;
const MAX_USER_ID_LENGTH = 128;

export type DeviceRole = 'owner' | 'member';

export interface StoredDevice {
  deviceId: string;
  role: DeviceRole;
  credentialHash: string;
  /** 主人签发的设备证书:其他设备据此核对这台设备发出的消息。 */
  cert: RelayDeviceCert;
  /** 设备在 hello 里自报的名字。 */
  reportedName: string;
  /** 用户改过的名字;null = 用自报名。 */
  customName: string | null;
  platform: string | null;
  appVersion: string | null;
  deviceInfo: DeviceInfo | null;
  pairedAt: number;
  lastSeenAt: number | null;
}

export interface RelayStateFile {
  schema: typeof STATE_SCHEMA;
  relayId: string;
  name: string;
  ownerUserId: string;
  ownerPublicKey: string;
  mediaSigningKey: string;
  devices: StoredDevice[];
}

export interface InitializeRelayInput {
  /** 中转的展示名,加入页与设置页显示。 */
  name: string;
  /** 主人电脑登录的 Cindy 账号 ID;hello-ack.userId 原样返回,加入时用于防误操作。 */
  ownerUserId: string;
  /** 主人电脑与官方登录相同的设备 ID。 */
  ownerDeviceId: string;
  ownerDeviceName: string;
  /** 主人电脑凭证的 SHA-256;明文只留在主人电脑。 */
  ownerCredentialHash: string;
  /** 中转 ID 由主人电脑生成(UUID):主人证书要签进这个 ID。 */
  relayId: string;
  /** 主人公钥;私钥只留在主人电脑。 */
  ownerPublicKey: string;
  /** 主人给自己签发的设备证书。 */
  ownerCert: unknown;
  now?: number;
}

export function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) return null;
  return trimmed;
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_USER_ID_LENGTH;
}

export function createRelayState(input: InitializeRelayInput): RelayStateFile {
  const name = normalizeName(input.name);
  const ownerDeviceName = normalizeName(input.ownerDeviceName);
  if (!name || !ownerDeviceName) throw new RelayError('BAD_REQUEST', 'invalid relay or device name');
  if (!isValidUserId(input.ownerUserId)) throw new RelayError('BAD_REQUEST', 'invalid owner account');
  if (!DEVICE_ID_PATTERN.test(input.ownerDeviceId)) throw new RelayError('BAD_REQUEST', 'invalid owner device id');
  if (!isSha256Hex(input.ownerCredentialHash)) throw new RelayError('BAD_REQUEST', 'invalid owner credential hash');
  if (!RELAY_ID_PATTERN.test(input.relayId)) throw new RelayError('BAD_REQUEST', 'invalid relay id');
  if (!isRelayPublicKey(input.ownerPublicKey)) throw new RelayError('BAD_REQUEST', 'invalid owner public key');
  const ownerCert = verifyRelayDeviceCert(nodeRelayAuthCrypto, input.ownerPublicKey, input.relayId, input.ownerCert);
  if (!ownerCert || ownerCert.role !== 'owner' || ownerCert.deviceId !== input.ownerDeviceId) {
    throw new RelayError('BAD_REQUEST', 'invalid owner certificate');
  }

  const state: RelayStateFile = {
    schema: STATE_SCHEMA,
    relayId: input.relayId,
    name,
    ownerUserId: input.ownerUserId,
    ownerPublicKey: input.ownerPublicKey,
    mediaSigningKey: createSecret(),
    devices: [
      {
        deviceId: input.ownerDeviceId,
        role: 'owner',
        credentialHash: input.ownerCredentialHash,
        cert: ownerCert,
        reportedName: ownerDeviceName,
        customName: null,
        platform: null,
        appVersion: null,
        deviceInfo: null,
        pairedAt: input.now ?? Date.now(),
        lastSeenAt: null,
      },
    ],
  };
  return state;
}

export function parseStoredDevice(raw: unknown, relayId: string, ownerPublicKey: string): StoredDevice | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.deviceId !== 'string' || !DEVICE_ID_PATTERN.test(d.deviceId)) return null;
  if (d.role !== 'owner' && d.role !== 'member') return null;
  if (!isSha256Hex(d.credentialHash)) return null;
  const cert = verifyRelayDeviceCert(nodeRelayAuthCrypto, ownerPublicKey, relayId, d.cert);
  if (!cert || cert.deviceId !== d.deviceId || cert.role !== d.role) return null;
  if (typeof d.reportedName !== 'string') return null;
  if (typeof d.pairedAt !== 'number') return null;
  return {
    deviceId: d.deviceId,
    role: d.role,
    credentialHash: d.credentialHash,
    cert,
    reportedName: d.reportedName,
    customName: typeof d.customName === 'string' ? d.customName : null,
    platform: typeof d.platform === 'string' ? d.platform : null,
    appVersion: typeof d.appVersion === 'string' ? d.appVersion : null,
    deviceInfo: d.deviceInfo && typeof d.deviceInfo === 'object' ? (d.deviceInfo as DeviceInfo) : null,
    pairedAt: d.pairedAt,
    lastSeenAt: typeof d.lastSeenAt === 'number' ? d.lastSeenAt : null,
  };
}

/** Both the filesystem relay and Durable Objects supply this capability. */
export interface RelayStorePort {
  readonly relayId: string;
  readonly ownerUserId: string;
  readonly ownerPublicKey: string;
  readonly mediaSigningKey: string;
  readonly relayName: string;
  get(deviceId: string): StoredDevice | undefined;
  list(): StoredDevice[];
  findByCredential(credential: string): StoredDevice | undefined;
  certificates(): RelayDeviceCert[];
  admitMember(input: {
    deviceId: string; credentialHash: string; cert: RelayDeviceCert; reportedName: string;
    platform: string | null; appVersion: string | null; now: number;
  }): StoredDevice;
  remove(deviceId: string): StoredDevice | undefined;
  update(deviceId: string, patch: Partial<Pick<StoredDevice,
    'reportedName' | 'customName' | 'platform' | 'appVersion' | 'deviceInfo' | 'lastSeenAt'>>): StoredDevice | undefined;
}
