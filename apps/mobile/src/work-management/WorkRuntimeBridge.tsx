import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { getMobileAuthOwner, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { useSelfHostedRelayRouteGeneration } from '@/device-link/selfHostedRelay';
import { mobileWork, stopMobileWork } from './runtime';

export function WorkRuntimeBridge() {
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner), generation = useSelfHostedRelayRouteGeneration();
  useEffect(() => {
    const work = mobileWork();
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') work?.wake(); else work?.pause(); });
    return () => { subscription.remove(); if (work) stopMobileWork(work); };
  }, [owner.accountKey, owner.generation, generation]);
  return null;
}
