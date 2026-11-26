import type { HubConnectionState, RelaySocket } from '../src/hub';
import type { EdgeSocket } from './runtime';

/** Native DO callbacks feed the shared Hub; no event listener pins an isolate. */
export class DurableSocket implements RelaySocket {
  private readonly listeners = new Map<string, Array<(...args: any[]) => void>>();
  constructor(readonly socket: EdgeSocket, readonly credentialHash?: string) {}
  get readyState() { return this.socket.readyState; }
  get bufferedAmount() { return 0; }
  send(text: string) { this.socket.send(text); }
  close(code: number, reason: string) { this.socket.close(code, reason); }
  terminate() { this.socket.close(1001, 'connection expired'); }
  on(event: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }
  emit(event: string, ...args: unknown[]) { for (const listener of this.listeners.get(event) ?? []) listener(...args); }
  persistConnection(connection: HubConnectionState) {
    this.socket.serializeAttachment({ ...(this.credentialHash ? { credentialHash: this.credentialHash } : {}), connection });
  }
}
