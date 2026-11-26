/** Host-owned I/O. No React, DOM, Electron or Expo dependency. */
export interface HttpReply { status: number; body: string }
export interface WorkbenchHost { call<T>(operation: string, payload?: unknown): Promise<T> }
export const uniqueId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
