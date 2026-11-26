import { app } from 'electron';
import { createVaultWatchers } from './watchers';
import { activeSelfHostedRelay } from '../device-link/selfHostedRelayRouting';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap';
import { createLogger } from '../logger';
import { createVaultSyncLoop, syncConfiguredVaults } from './service';

const log = createLogger('vault-sync');
export function createDesktopVaultSync(ownsConnection: () => boolean) {
  const ids = new Set<string>(), seen = new Map<string, number>();
  let routeKey = '';
  const watchers = createVaultWatchers(app.getPath('userData'), () => loop.wake());
  const loop = createVaultSyncLoop(async current => {
    const route = activeSelfHostedRelay();
    if (!route || route.authMode !== 'none' || !ownsConnection()) return;
    const key = JSON.stringify([route.baseUrl, route.relayId]);
    if (key !== routeKey) { routeKey = key; seen.clear(); }
    const scope = captureDataOwnerBroadcastScope();
    const valid = () => current() && ownsConnection() && isDataOwnerBroadcastScopeCurrent(scope)
      && activeSelfHostedRelay()?.baseUrl === route.baseUrl && activeSelfHostedRelay()?.relayId === route.relayId;
    await syncConfiguredVaults(app.getPath('userData'), route.baseUrl, valid, result => {
      if (valid()) seen.set(result.id, result.revision);
      if (valid()) log.debug('vault pass completed', { uploaded: result.uploaded, downloaded: result.downloaded, conflicts: result.conflicts.length });
    }, vaults => { ids.clear(); for (const vault of vaults) ids.add(vault.id); watchers.configure(vaults); });
  }, () => log.warn('vault sync paused until next attempt'));
  return { wake: loop.wake, changed(vaultId: string, revision: number) { if (ids.has(vaultId) && revision > (seen.get(vaultId) ?? 0)) loop.wake(); }, stop() { watchers.stop(); loop.stop(); } };
}
