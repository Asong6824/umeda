import { AppState } from 'react-native';
import { LibraryService } from '../../../../packages/kos-workbench/src/library/service';
import { dispatchLibrary, runLibrary } from '../../../../packages/kos-workbench/src/library/rpc';
import { libraryStorage } from './database';
import { vaultStorageScope } from './scope';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { getActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';

interface Session {
  key: string;
  service: LibraryService;
  call: (input: unknown) => Promise<unknown>;
  wake: () => Promise<void>;
  stop: () => void;
}
let session: Session | null = null;

/** Owned by the app, shared by every KOS view. Closing a view does not stop delivery. */
export function mobileLibrary(): Session | null {
  const owner = getMobileAuthOwner(), route = getActiveSelfHostedRelay();
  if (!route || route.authMode !== 'none') { stopMobileLibrary(); return null; }
  const scope = vaultStorageScope(owner.accountKey, route), key = JSON.stringify([scope, route.baseUrl, owner.generation]);
  if (session?.key === key) return session;
  stopMobileLibrary();
  let alive = true;
  const controllers = new Set<AbortController>();
  const valid = () => alive && isMobileAuthOwnerCurrent(owner) && getActiveSelfHostedRelay()?.baseUrl === route.baseUrl
    && getActiveSelfHostedRelay()?.relayId === route.relayId;
  const storage = libraryStorage(scope, valid);
  const service = new LibraryService({ async call<T>(operation: string, raw?: unknown): Promise<T> {
    if (!valid()) throw new Error('STALE_LIBRARY_SCOPE');
    const payload = (raw ?? {}) as Record<string, any>;
    if (operation === 'info') return { namespace: scope, atomic: true, contentSearch: true, storageReport: true } as T;
    if (operation === 'get') return await storage.get(payload.key) as T;
    if (operation === 'set') { await storage.set(payload.key, payload.value); return undefined as T; }
    if (operation === 'remove') { await storage.set(payload.key, null); return undefined as T; }
    if (operation === 'commit') { await storage.commit(payload.entries, valid); return undefined as T; }
    if (operation === 'storageReport') return await storage.report(payload.namespace, payload.pinnedKeys) as T;
    if (operation === 'contentSearch') return await storage.search(payload.keys, payload.query) as T;
    if (operation !== 'http' || AppState.currentState !== 'active') throw new Error('LIBRARY_PAUSED');
    if (typeof payload.path !== 'string' || !/^\/api\/vaults(?:[/?]|$)/.test(payload.path) || payload.path.includes('..')) throw new Error('INVALID_LIBRARY_PATH');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000);
    controllers.add(controller);
    try {
      const response = await fetch(route.baseUrl + payload.path, { method: payload.method ?? 'GET', headers: payload.headers, body: payload.body, signal: controller.signal });
      if (!valid()) throw new Error('STALE_LIBRARY_SCOPE');
      if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('LIBRARY_REPLY_TOO_LARGE');
      const body = await response.text();
      if (!valid() || body.length > 4 * 1024 * 1024) throw new Error('INVALID_LIBRARY_REPLY');
      return { status: response.status, body } as T;
    } finally { clearTimeout(timer); controllers.delete(controller); }
  } });
  const runner = runLibrary(service, () => valid() && AppState.currentState === 'active');
  session = { key, service, async call(input) {
    if (!valid()) throw new Error('STALE_LIBRARY_SCOPE');
    const result = await dispatchLibrary(service, input);
    if (!valid()) throw new Error('STALE_LIBRARY_SCOPE');
    return result;
  }, wake: runner.wake,
    stop() { alive = false; for (const controller of controllers) controller.abort(); runner.stop(); } };
  void runner.wake();
  return session;
}
export function stopMobileLibrary(expected?: Session) { if (expected && session !== expected) return; session?.stop(); session = null; }
