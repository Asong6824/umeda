/** Unit: shared production receiver coalesces reconnect/notices, backs off failed writes,
 * and stops stale claims. Relay tests do not exercise host scheduling. Fake time only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUmedaCommandConsumer, type UmedaCommandClaim } from '../umedaCommands';
afterEach(() => vi.useRealTimers());
const command: UmedaCommandClaim = { clientId: 'input', sourceDeviceId: 'phone', targetDeviceId: 'mac',
  sessionId: 'task', message: {}, sendAtMs: 1, leaseId: 'lease', expectedClearBoundaryMs: null };
describe('durable inbox consumer', () => {
  it('drains through one consumer while notices arrive, without starting the same claim twice', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { command: UmedaCommandClaim }) => void;
    let claims = 0;
    const request = vi.fn(async (path: string) => {
      if (!path.endsWith('/claim')) return {};
      if (++claims === 1) return new Promise<{ command: UmedaCommandClaim }>(r => { resolve = r; });
      return { command: null };
    });
    const execute = vi.fn(async () => ({ state: 'accepted' as const }));
    const receiver = createUmedaCommandConsumer({ available: () => true, request: request as any, execute });
    receiver.wake();
    for (let i = 0; i < 20; i++) receiver.wake();
    resolve({ command }); await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/settle'))).toHaveLength(1);
    receiver.stop();
  });
  it('backs off an uncertain acknowledgement rather than rapidly executing a new claim', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (path: string) => {
      if (path.endsWith('/settle')) throw new Error('receipt lost');
      return { command };
    });
    const execute = vi.fn(async () => ({ state: 'accepted' as const }));
    const receiver = createUmedaCommandConsumer({ available: () => true, request: request as any, execute });
    receiver.wake(); await vi.advanceTimersByTimeAsync(0);
    expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(4_999); expect(execute).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1); expect(execute).toHaveBeenCalledTimes(2);
    receiver.stop();
  });
  it('never executes a late claim after the owning process stops', async () => {
    vi.useFakeTimers();
    let resolve!: (value: { command: UmedaCommandClaim }) => void;
    const request = vi.fn(() => new Promise<{ command: UmedaCommandClaim }>(r => { resolve = r; }));
    const execute = vi.fn(async () => ({ state: 'accepted' as const }));
    const receiver = createUmedaCommandConsumer({ available: () => true, request: request as any, execute });
    receiver.wake(); receiver.stop(); resolve({ command }); await vi.advanceTimersByTimeAsync(0);
    expect(execute).not.toHaveBeenCalled(); expect(request).toHaveBeenCalledOnce();
  });
});
