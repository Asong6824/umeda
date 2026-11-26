/** Small structural ports: the core remains independent of Cloudflare globals. */
import type { HubConnectionState } from '../src/hub';

export interface ObjectStorage {
  transaction?<T>(operation: (storage: ObjectStorage) => Promise<T>): Promise<T>;
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string | string[]): Promise<unknown>;
  list<T>(options: { prefix: string; start?: string; startAfter?: string; end?: string; limit?: number; reverse?: boolean }): Promise<Map<string, T>>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface EdgeSocket {
  readyState: number;
  send(value: string | ArrayBuffer): void;
  close(code: number, reason: string): void;
  serializeAttachment(value: SocketAttachment): void;
  deserializeAttachment(): SocketAttachment | null;
}

export interface SocketAttachment {
  credentialHash?: string;
  connection: HubConnectionState;
}

export interface ObjectContext {
  storage: ObjectStorage;
  blockConcurrencyWhile<T>(operation: () => Promise<T>): Promise<T>;
  getWebSockets(): EdgeSocket[];
  acceptWebSocket(socket: EdgeSocket): void;
  waitUntil(promise: Promise<unknown>): void;
}

export interface RelayEnvironment {
  UMEDA_WORK?: RelayEnvironment['UMEDA_RELAY'];
  UMEDA_VAULT?: import('./vault').VaultBucket;
  UMEDA_RELAY: { idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> } };
  /** Owner public key only. No private key or LLM credential is deployed. */
  UMEDA_OWNER_PUBLIC_KEY?: string;
  /** Explicit personal deployment choice: no client authentication or pairing. */
  UMEDA_AUTH_MODE?: 'none';
}

declare global {
  var WebSocketPair: { new(): { 0: EdgeSocket; 1: EdgeSocket } };
}
