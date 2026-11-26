/**
 * Unit: personal standalone build, unlike explicit legacy builds exercised by apiClient/sessionLinks.
 * A separate file isolates the module-level build flag without resetting modules.
 * Minimal failures: a generated task link opens the account app, or a request with an
 * account token reaches an official/retired endpoint. Verify actual URLs and network output.
 * Single-file wall time: 1.40s on macOS.
 */
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('@/config/standalone', () => ({ UMEDA_STANDALONE: true, UMEDA_LOCAL_OWNER: 'local-v1' }));
vi.mock('expo-crypto', () => ({ getRandomBytes: () => new Uint8Array(32) }));
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
} }));
vi.mock('@/auth/secureStorage', () => ({ getSecureItem: vi.fn(), setSecureItem: vi.fn(), deleteSecureItem: vi.fn() }));
import { AUTH_REGION, APP_SCHEME } from '@/config/env';
import { apiFetchRaw } from '@/api/client';
import { currentSelfHostedRelayFrameAuth } from '@/device-link/selfHostedRelayFrameAuth';
import { configureStandaloneRelay } from '@/device-link/selfHostedRelay';
import { getSecureItem } from '@/auth/secureStorage';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { __testing, selfHostedRelayAuthorizationFor, setActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import { buildMobileSessionDeepLink, parseSessionDeepLinkUrl, parseProjectDeepLinkUrl } from '@/session/sessionLinks';

afterEach(() => { setMobileAuthOwner(null); storage.clear(); __testing.reset(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

// Unit: first personal install and existing paired install must both start without
// QR/pairing or keychain access. The earlier transport test only installed an in-memory route.
it.each(['preset', 'existing'] as const)('restores a public URL from %s without loading old secrets', async source => {
  setMobileAuthOwner('local-v1', 'global');
  if (source === 'preset') vi.stubEnv('EXPO_PUBLIC_UMEDA_RELAY_URL', 'https://preset.example.invalid');
  else {
    vi.stubEnv('EXPO_PUBLIC_UMEDA_RELAY_URL', '');
    storage.set('cindy.mobile.self-hosted-relay.v2.' + getMobileAuthOwner().accountKey,
      JSON.stringify({ baseUrl: 'https://existing.example.invalid', name: 'Existing', relayId: 'r' }));
  }
  await configureStandaloneRelay('phone');
  expect(selfHostedRelayAuthorizationFor(`https://${source === 'preset' ? 'preset' : 'existing'}.example.invalid`))
    .toEqual({ kind: 'open', deviceId: 'phone' });
  expect(getSecureItem).not.toHaveBeenCalled();
  expect(currentSelfHostedRelayFrameAuth()).toBeNull();
});

// Unit: the explicit personal no-auth route sends no credentials and needs no signer.
// Existing signed-route coverage could not distinguish a null credential from a broken install.
it('uses the configured public relay without credentials, signatures or certificate fetches', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ devices: [] }));
  vi.stubGlobal('fetch', fetch);
  setActiveSelfHostedRelay({ relayId: 'umeda', name: 'Umeda', baseUrl: 'https://relay.example.invalid',
    authMode: 'none', deviceId: 'phone', credential: null, signing: null });
  expect(currentSelfHostedRelayFrameAuth()).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
  await expect(apiFetchRaw('/api/device-link/devices', {
    baseUrl: 'https://relay.example.invalid', token: 'fake-account-token',
    headers: { Authorization: 'fake-obsolete-credential' },
  })).resolves.toEqual({ devices: [] });
  const headers = fetch.mock.calls[0]![1].headers;
  expect(headers).not.toHaveProperty('Authorization');
  expect(headers['x-umeda-device-id']).toBe('phone');
});

it('opens standalone task links in its own app and still recognizes desktop task links', () => {
  const link = buildMobileSessionDeepLink('task/1', { deviceId: 'desktop' });
  expect(link).toBe('umeda://session/task%2F1?device=desktop');
  const target = { sessionId: 'task/1', deviceId: 'desktop', messageClientId: null };
  expect(parseSessionDeepLinkUrl(link)).toEqual(target);
  expect(parseSessionDeepLinkUrl(link.replace('umeda:', 'cindy:'))).toEqual(target);
  expect(parseProjectDeepLinkUrl('umeda://project/%2Frepo')).toEqual({ workingDir: '/repo' });
  expect(AUTH_REGION).toBe('global');
  expect(APP_SCHEME).toBe('umeda');
});

it('refuses official requests before networking even when an account token is supplied', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await expect(apiFetchRaw('/api/device-link/devices', {
    baseUrl: 'https://official.example.invalid', token: 'fake-account-token',
  })).rejects.toMatchObject({ code: 'LOCAL_MODE' });
  expect(fetch).not.toHaveBeenCalled();
});

it('uses only the current relay credential and refuses requests after its route is retired', async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json({ devices: [] }));
  vi.stubGlobal('fetch', fetch);
  setActiveSelfHostedRelay({ relayId: 'relay', name: 'Test relay', baseUrl: 'https://relay.example.invalid',
    credential: 'fake-relay-credential', signing: null });
  const options = { baseUrl: 'https://relay.example.invalid', token: 'fake-account-token' };
  await expect(apiFetchRaw('/api/device-link/devices', options)).resolves.toEqual({ devices: [] });
  expect(fetch.mock.calls[0]![1].headers.Authorization).toBe('CindyRelay fake-relay-credential');
  setActiveSelfHostedRelay(null);
  await expect(apiFetchRaw('/api/device-link/devices', options)).rejects.toMatchObject({ code: 'RELAY_CREDENTIAL_UNAVAILABLE' });
  expect(fetch).toHaveBeenCalledOnce();
});
