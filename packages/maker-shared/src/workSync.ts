import { WORK_SYNC_PREFIX, type WorkEnvelope, type WorkFeed, type WorkReplicaRequest } from './workReplication';

export interface WorkSyncPorts {
  scope: string;
  replica(request: WorkReplicaRequest): Promise<Record<string, unknown>>;
  http(path: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  current(): boolean;
  changed(): void;
}
/** A bounded pass. Cursors commit locally before the next page or upload. */
export async function syncWork(ports: WorkSyncPorts): Promise<boolean> {
  const check = () => { if (!ports.current()) throw new Error('WORK_CONTEXT_CHANGED'); };
  check();
  await ports.replica({ operation: 'bind', scope: ports.scope }); check();
  const pull = async () => {
    for (let page = 0; page < 50; page++) {
      check();
      const status = await ports.replica({ operation: 'checkpoint' }); check();
      const response = await ports.http(`${WORK_SYNC_PREFIX}/changes?after=${status.cursor}`); check();
      if (response.status !== 200) throw new Error((response.body as { error?: string })?.error === 'WORK_SYNC_CURSOR_AHEAD' ? 'WORK_SYNC_CURSOR_AHEAD' : 'WORK_SYNC_UNAVAILABLE');
      const feed = response.body as WorkFeed;
      await ports.replica({ operation: 'apply', feed }); check();
      if (feed.commits.length) ports.changed();
      if (!feed.more) return false;
    }
    return true;
  };
  if (await pull()) return true;
  for (let count = 0; count < 50; count++) {
    check();
    const next = await ports.replica({ operation: 'pending' }); check();
    const envelope = next.envelope as WorkEnvelope | undefined;
    if (!envelope) return false;
    const response = await ports.http(`${WORK_SYNC_PREFIX}/commits`, envelope); check();
    if (response.status !== 200) {
      const error = (response.body as { error?: unknown })?.error;
      if (response.status >= 400 && response.status < 500 && typeof error === 'string' && ['WORK_VERSION_CONFLICT', 'WORK_REQUEST_REUSED', 'WORK_NOT_FOUND', 'WORK_INVALID_RELATION', 'WORK_INVALID_INPUT'].includes(error)) {
        if (envelope.request.operation !== 'create' && envelope.request.operation !== 'update') throw new Error('WORK_INVALID_INPUT');
        await ports.replica({ operation: 'reject', request_id: envelope.request.request_id, error }); ports.changed();
      } else throw new Error('WORK_SYNC_UNAVAILABLE');
    }
    if (await pull()) return true;
  }
  return true;
}

/** One loop per application owner, never one poller per page. */
export function createWorkSyncLoop(run: (current: () => boolean) => Promise<boolean>, failed: () => void) {
  let stopped = false, running = false, wanted = false, failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retryAt = 0;
  const wake = () => {
    if (stopped) return;
    if (running) { wanted = true; return; }
    if (timer) clearTimeout(timer);
    if (Date.now() < retryAt) { timer = setTimeout(wake, retryAt - Date.now()); return; }
    running = true; wanted = false;
    void run(() => !stopped).then(more => { failures = 0; wanted ||= more; }, () => { failures++; failed(); }).finally(() => {
      running = false;
      const delay = failures ? Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6)) : wanted ? 0 : 120_000;
      retryAt = failures ? Date.now() + delay : 0;
      if (!stopped) timer = setTimeout(wake, delay);
    });
  };
  return { wake, stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
