/** Optional personal-relay inbox. This is not a generic replayable RPC tunnel. */
export const UMEDA_COMMAND_FEATURE = 'durable-input-v1';
export const UMEDA_COMMAND_NOTICE = 'umeda:commands:changed';
export const UMEDA_COMMAND_PATH = '/api/device-link/relay/commands';
export const UMEDA_COMMAND_MAX_BYTES = 60 * 1024;
export const UMEDA_COMMAND_TTL_MS = 24 * 60 * 60_000;
export type UmedaCommandState = 'queued' | 'accepted' | 'failed' | 'cancelled' | 'expired';

export interface UmedaCommandInput {
  clientId: string;
  targetDeviceId: string;
  sessionId: string;
  message: Record<string, unknown>;
  sendAtMs: number;
  expectedClearBoundaryMs: number | null;
  resourceRef?: { collectionId: string; kind: string; id: string };
}
export interface UmedaCommandReceipt {
  clientId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sessionId: string;
  state: UmedaCommandState;
  createdAt: number;
  expiresAt: number;
  errorCode?: string;
}
export interface UmedaCommandClaim extends UmedaCommandInput {
  sourceDeviceId: string;
  leaseId: string;
  /** Relay directory metadata, never taken from the queued message. Display only. */
  sourcePlatform?: string | null;
  sourceName?: string | null;
}
export interface UmedaCommandSettlement {
  sourceDeviceId: string;
  clientId: string;
  leaseId: string;
  state: 'accepted' | 'failed' | 'retry';
  errorCode?: string;
}

export function isUmedaCommandInput(value: unknown): value is UmedaCommandInput {
  if (!value || typeof value !== 'object') return false;
  const v = value as UmedaCommandInput;
  const label = (s: unknown) => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(s);
  const m = v.message;
  return label(v.clientId) && label(v.targetDeviceId) && label(v.sessionId)
    && Number.isFinite(v.sendAtMs) && v.sendAtMs > 0
    && (v.expectedClearBoundaryMs === null
      || (Number.isFinite(v.expectedClearBoundaryMs) && v.expectedClearBoundaryMs >= 0))
    && !!m && typeof m === 'object' && !Array.isArray(m)
    && m.clientId === v.clientId && m.durableDelivery === true
    && typeof m.text === 'string' && typeof m.persistedContent === 'string'
    && !!m.createOpts && typeof m.createOpts === 'object'
    && !!m.chatMessage && typeof m.chatMessage === 'object'
    && (m.chatMessage as Record<string, unknown>).clientId === v.clientId
    && (v.resourceRef === undefined || (!!v.resourceRef && typeof v.resourceRef === 'object'
      && [v.resourceRef.collectionId, v.resourceRef.kind, v.resourceRef.id]
        .every(s => typeof s === 'string' && s.length > 0 && s.length <= 160)));
}

export type UmedaCommandRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;

/** One consumer per relay owner process; notices coalesce, polling only repairs lost notices. */
export function createUmedaCommandConsumer(deps: {
  available(): boolean;
  request: UmedaCommandRequest;
  execute(command: UmedaCommandClaim): Promise<{ state: 'accepted' | 'failed' | 'retry'; errorCode?: string }>;
  retryMs?: number;
  idleMs?: number;
  observe?(event: 'settled' | 'request-failed', code: string): void;
}) {
  let stopped = false, running = false, again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  const observe = (event: 'settled' | 'request-failed', code: string) => {
    try { deps.observe?.(event, /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'UNKNOWN'); } catch { /* diagnostics are not delivery */ }
  };
  const schedule = (ms: number) => {
    if (stopped || !deps.available()) return;
    timer = setTimeout(wake, ms);
  };
  async function run() {
    if (stopped || !deps.available()) return;
    running = true;
    let delay = deps.idleMs ?? 300_000;
    try {
      // Bounded drain yields between batches; only one claimed input is in flight.
      for (let n = 0; n < 16 && !stopped && deps.available(); n++) {
        const { command, pending } = await deps.request<{ command: UmedaCommandClaim | null; pending?: boolean }>(`${UMEDA_COMMAND_PATH}/claim`, 'POST', {});
        if (!command || stopped || !deps.available()) {
          if (pending) delay = deps.retryMs ?? 30_000;
          break;
        }
        const result = await deps.execute(command);
        observe('settled', result.errorCode ?? result.state.toUpperCase());
        if (stopped || !deps.available()) break;
        await deps.request(`${UMEDA_COMMAND_PATH}/settle`, 'POST', {
          sourceDeviceId: command.sourceDeviceId, clientId: command.clientId, leaseId: command.leaseId, ...result,
        } satisfies UmedaCommandSettlement);
        if (result.state === 'retry') { delay = deps.retryMs ?? 30_000; continue; }
        if (n === 15) delay = 0;
      }
      failures = 0;
    } catch (error) {
      observe('request-failed', error && typeof error === 'object' && 'code' in error ? String(error.code) : 'NETWORK_OR_RECEIVER_CHANGED');
      delay = Math.min(300_000, (deps.retryMs ?? 5_000) * 2 ** Math.min(failures++, 6));
    } finally {
      running = false;
      if (again) { again = false; delay = 0; }
      schedule(delay);
    }
  }
  function wake() {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (running) { again = true; return; }
    void run();
  }
  return { wake, stop() { stopped = true; if (timer) clearTimeout(timer); } };
}
