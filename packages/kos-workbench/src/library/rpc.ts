import { isVaultId, isVaultPath, type VaultSummary } from '@cindy/device-link';
import type { LibraryService } from './service';
import type { BookTextPart } from './model';

export type LibraryCommand = 'ready' | 'snapshot' | 'refresh' | 'readText' | 'readBinaryPart'
  | 'saveText' | 'preference' | 'savePreference' | 'capture' | 'history' | 'readVersion' | 'restore' | 'move' | 'search' | 'pinOffline' | 'cancelOffline' | 'diagnostics' | 'cancelMove' | 'retryMove' | 'storageReport' | 'indexBookPart' | 'completeBookIndex';
export interface LibraryRequest { command: LibraryCommand; args?: Record<string, unknown> }

/** Domain boundary shared by native and plugin hosts. No arbitrary method invocation. */
export async function dispatchLibrary(service: LibraryService, input: unknown): Promise<unknown> {
  if (!input || typeof input !== 'object') throw new Error('INVALID_LIBRARY_COMMAND');
  const { command, args = {} } = input as LibraryRequest;
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('INVALID_LIBRARY_COMMAND');
  if (command === 'storageReport') return service.storageReport();
  if (command === 'diagnostics') return service.diagnostics();
  if (command === 'ready' || command === 'snapshot') { await service.ready(); return service.getSnapshot(); }
  if (command === 'refresh') { await service.ready(); await service.refresh(true); return service.getSnapshot(); }
  if (command === 'preference' || command === 'savePreference') {
    if (typeof args.key !== 'string' || args.key.length > 1800 || JSON.stringify(args.value ?? null).length > 1024 * 1024)
      throw new Error('INVALID_LIBRARY_PREFERENCE');
    if (command === 'preference') return service.preference(args.key, args.fallback);
    await service.savePreference(args.key, args.value); return;
  }
  if (!isVaultId(args.vaultId)) throw new Error('INVALID_LIBRARY_ID');
  if (command === 'indexBookPart' || command === 'completeBookIndex') {
    const file = args.file as VaultSummary;
    if (!file || !isVaultPath(file.path)) throw new Error('INVALID_LIBRARY_FILE');
    if (command === 'indexBookPart') await service.indexBookPart(args.vaultId, file, args.position as number, args.part as BookTextPart);
    else await service.completeBookIndex(args.vaultId, file, args.count as number);
    return service.getSnapshot();
  }
  if (command === 'cancelMove' || command === 'retryMove') {
    if (typeof args.id !== 'string' || !args.id || args.id.length > 160) throw new Error('INVALID_LIBRARY_OPERATION');
    await service[command](args.vaultId, args.id); return service.getSnapshot();
  }
  if (command === 'search') {
    if (typeof args.query !== 'string' || args.query.length > 200) throw new Error('INVALID_LIBRARY_SEARCH');
    return service.search(args.vaultId, args.query);
  }
  if (command === 'pinOffline' || command === 'cancelOffline') {
    if ((args.path !== undefined && !isVaultPath(args.path)) || (command === 'cancelOffline' && !isVaultPath(args.path))) throw new Error('INVALID_LIBRARY_PATH');
    if (command === 'pinOffline') await service.pinOffline(args.vaultId, args.path as string | undefined);
    else await service.cancelOffline(args.vaultId, args.path as string);
    return service.getSnapshot();
  }
  if (command === 'history') {
    if (!isVaultPath(args.path) || (args.before !== undefined && (!Number.isSafeInteger(args.before) || Number(args.before) < 1))) throw new Error('INVALID_LIBRARY_VERSION');
    return service.history(args.vaultId, args.path, args.before as number | undefined);
  }
  if (command === 'move' || command === 'restore') {
    if (!isVaultPath(args.path) || !Number.isSafeInteger(args.baseRevision) || Number(args.baseRevision) < 1) throw new Error('INVALID_LIBRARY_VERSION');
    if (command === 'move') {
      if (!isVaultPath(args.to)) throw new Error('INVALID_LIBRARY_PATH');
      await service.move(args.vaultId, args.path, args.to, Number(args.baseRevision));
    } else {
      if (!Number.isSafeInteger(args.revision) || Number(args.revision) < 1) throw new Error('INVALID_LIBRARY_VERSION');
      await service.restore(args.vaultId, args.path, Number(args.revision), Number(args.baseRevision));
    }
    return service.getSnapshot();
  }
  if (command === 'readVersion') {
    const file = args.file as VaultSummary;
    if (!file || !isVaultPath(file.path) || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error('INVALID_LIBRARY_VERSION');
    return service.readVersion(args.vaultId, file);
  }
  if (command === 'readText' || command === 'readBinaryPart') {
    const file = args.file as VaultSummary;
    if (!file || !isVaultPath(file.path) || !Number.isSafeInteger(file.revision) || file.revision < 0
      || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 32 * 1024 * 1024
      || (file.hash !== null && !/^[a-f0-9]{64}$/.test(file.hash))) throw new Error('INVALID_LIBRARY_FILE');
    return command === 'readText' ? service.readText(args.vaultId, file)
      : service.readBinaryPart(args.vaultId, file, args.offset as number);
  }
  if (command === 'saveText') {
    if (!isVaultPath(args.path) || typeof args.text !== 'string'
      || !Number.isSafeInteger(args.baseRevision) || (args.baseRevision as number) < 0) throw new Error('INVALID_LIBRARY_EDIT');
    await service.saveText(args.vaultId, args.path, args.text, args.baseRevision as number); return service.getSnapshot();
  }
  if (command === 'capture') {
    if (typeof args.title !== 'string' || args.title.length > 1000 || typeof args.body !== 'string') throw new Error('INVALID_LIBRARY_EDIT');
    return service.capture(args.vaultId, args.title, args.body);
  }
  throw new Error('INVALID_LIBRARY_COMMAND');
}

/** One runner per host scope, not one per view. A failed view never resets the shared relay. */
export function runLibrary(service: LibraryService, active: () => boolean) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, failures = 0;
  let running: Promise<void> | null = null;
  const wake = () => {
    if (stopped || !active()) return Promise.resolve();
    if (timer) clearTimeout(timer);
    if (running) { void service.refresh(true); return running; }
    running = service.ready().then(() => service.refresh(true)).then(() => service.syncOffline()).then(() => {
      failures = service.getSnapshot().offline ? failures + 1 : 0;
    }).catch(() => { failures++; }).finally(() => {
      running = null;
      if (!stopped) timer = setTimeout(() => { void wake(); }, Math.min(300_000, 30_000 * 2 ** Math.min(failures, 4)));
    });
    return running;
  };
  return { wake, stop() { stopped = true; clearTimeout(timer); service.dispose(); } };
}
