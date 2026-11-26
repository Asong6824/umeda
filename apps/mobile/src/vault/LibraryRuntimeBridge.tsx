import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useSelfHostedRelayRouteGeneration } from '@/device-link/selfHostedRelay';
import { subscribeVaultChanges } from './events';
import { mobileLibrary, stopMobileLibrary } from './runtime';

/** Lifecycle adapter only; the service and its durable state are not React state. */
export function LibraryRuntimeBridge() {
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner), generation = useSelfHostedRelayRouteGeneration();
  useEffect(() => {
    const library = mobileLibrary();
    const app = AppState.addEventListener('change', state => { if (state === 'active') void mobileLibrary()?.wake(); });
    const stop = subscribeVaultChanges((vaultId, revision) => {
      const library = mobileLibrary();
      if (revision > (library?.service.getSnapshot().catalog.cursors[vaultId] ?? 0)) void library?.wake();
    });
    return () => { app.remove(); stop(); if (library) stopMobileLibrary(library); };
  }, [owner.accountKey, owner.generation, generation]);
  return null;
}
