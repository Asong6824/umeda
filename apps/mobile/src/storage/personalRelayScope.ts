import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { utf8Bytes } from '@cindy/device-link';
import type { SelfHostedRelayRoute } from '@/device-link/selfHostedRelayRouting';
import { UMEDA_STANDALONE } from '@/config/standalone';

function httpsOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/** A build may explicitly declare a new address for the same personal relay.
 * Keep its offline drafts/queue in their original namespace; never infer aliases
 * from a server response or apply the alias to a different runtime route.
 */
export function personalRelayStorageScope(accountKey: string, route: Pick<SelfHostedRelayRoute, 'baseUrl' | 'relayId' | 'authMode'>): string {
  const configured = httpsOrigin(process.env.EXPO_PUBLIC_UMEDA_RELAY_URL);
  const previous = httpsOrigin(process.env.EXPO_PUBLIC_UMEDA_PREVIOUS_RELAY_URL);
  const storageBase = UMEDA_STANDALONE && route.authMode === 'none' && configured && previous
    && httpsOrigin(route.baseUrl) === configured ? previous : route.baseUrl;
  return bytesToHex(sha256(utf8Bytes(JSON.stringify([accountKey, storageBase, route.relayId]))));
}
