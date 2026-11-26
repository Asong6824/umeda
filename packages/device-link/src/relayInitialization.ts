import { decodeBase64Url, encodeBase64Url, relayPublicKeyOf, type RelayAuthCrypto, type RelayDeviceCert } from './selfHostedRelayAuth.js';

/** Public bootstrap material. The owner's private key and credential stay on device. */
export interface RelayInitialization {
  relayId: string;
  name: string;
  ownerUserId: string;
  ownerDeviceId: string;
  ownerDeviceName: string;
  ownerCredentialHash: string;
  ownerPublicKey: string;
  ownerCert: RelayDeviceCert;
}

function transcript(input: RelayInitialization): Uint8Array {
  const cert = input.ownerCert;
  return new TextEncoder().encode(JSON.stringify([
    'umeda-relay-initialization/1', input.relayId, input.name, input.ownerUserId,
    input.ownerDeviceId, input.ownerDeviceName, input.ownerCredentialHash, input.ownerPublicKey,
    [cert.v, cert.relayId, cert.deviceId, cert.publicKey, cert.role, cert.issuedAt, cert.signature],
  ]));
}

export function signRelayInitialization(crypto: RelayAuthCrypto, seed: string, input: RelayInitialization): string {
  const bytes = decodeBase64Url(seed);
  if (!bytes || bytes.length !== 32 || relayPublicKeyOf(crypto, seed) !== input.ownerPublicKey) {
    throw new Error('Invalid relay initialization identity');
  }
  return encodeBase64Url(crypto.ed25519Sign(bytes, transcript(input)));
}

/** A public self-certificate alone cannot authorize a replacement credential hash. */
export function verifyRelayInitialization(
  crypto: RelayAuthCrypto, pinnedOwnerKey: string, input: RelayInitialization, proof: unknown,
): boolean {
  if (pinnedOwnerKey !== input.ownerPublicKey || typeof proof !== 'string') return false;
  const publicKey = decodeBase64Url(pinnedOwnerKey);
  const signature = decodeBase64Url(proof);
  if (!publicKey || publicKey.length !== 32 || !signature || signature.length !== 64) return false;
  try { return crypto.ed25519Verify(publicKey, transcript(input), signature); }
  catch { return false; }
}
