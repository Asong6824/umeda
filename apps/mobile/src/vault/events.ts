import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { getActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import { parseVaultChange } from '@cindy/device-link';

const listeners = new Set<(vaultId: string, revision: number) => void>();
export function subscribeVaultChanges(listener: (vaultId: string, revision: number) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
/** Snapshot belongs to the socket lifetime; old route/owner hints never enter a new view. */
export function createVaultNotifier(current: () => boolean) {
  const owner = getMobileAuthOwner(),
    route = getActiveSelfHostedRelay();
  return (payload: unknown) => {
    const active = getActiveSelfHostedRelay(),
      change = parseVaultChange(payload);
    if (
      !current() ||
      !isMobileAuthOwnerCurrent(owner) ||
      !route ||
      route.authMode !== 'none' ||
      active?.baseUrl !== route.baseUrl ||
      active.relayId !== route.relayId ||
      !change
    )
      return;
    for (const listener of listeners) listener(change.vaultId, change.revision);
  };
}
