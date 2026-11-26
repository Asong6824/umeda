import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { isVaultPath } from '@cindy/device-link';
import type { VaultConfiguration } from './service';

/** Watch hints accelerate the regular hash-verified mirror; polling repairs missed/unsupported events. */
export function createVaultWatchers(userData: string, wake: () => void) {
  const roots = new Map<string, FSWatcher>();
  let configuration: FSWatcher | undefined,
    timer: ReturnType<typeof setTimeout> | undefined,
    stopped = false;
  const schedule = () => {
    if (stopped || timer !== undefined) return;
    timer = setTimeout(() => { timer = undefined; wake(); }, 250);
  };
  try {
    configuration = watch(userData, (_event, name) => {
      if (String(name) === 'vault-sync.json') schedule();
    });
    configuration.on('error', () => {
      configuration?.close();
      configuration = undefined;
    });
  } catch {
    /* Existing timer remains the fallback. */
  }
  return {
    configure(vaults: VaultConfiguration[]) {
      const directories = new Set(vaults.map((vault) => vault.directory));
      for (const [root, watcher] of roots)
        if (!directories.has(root)) {
          watcher.close();
          roots.delete(root);
        }
      for (const root of directories)
        if (!roots.has(root) && !stopped)
          try {
            const watcher = watch(root, { recursive: true }, (_event, name) => {
              if (name === null || isVaultPath(String(name).split(path.sep).join('/'))) schedule();
            });
            watcher.on('error', () => {
              watcher.close();
              roots.delete(root);
            });
            roots.set(root, watcher);
          } catch {
            /* A temporarily missing directory or unsupported platform still uses periodic scanning. */
          }
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      configuration?.close();
      for (const watcher of roots.values()) watcher.close();
      roots.clear();
    },
  };
}
