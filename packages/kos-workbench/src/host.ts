import type { HttpReply, WorkbenchHost } from './library/ports';
export type { HttpReply, WorkbenchHost } from './library/ports';
export { uniqueId } from './library/ports';
import { uniqueId } from './library/ports';
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(value: string): void };
    umedaWorkbenchClose?: () => Promise<void>;
    umedaWorkbenchReply?: (reply: { id: string; result?: unknown; error?: string }) => void;
    __UMEDA_BOOT__?: { platform: 'mobile' | 'desktop'; theme: 'light' | 'dark'; locale: string; hostLibrary?: boolean };
    __UMEDA_PREVIEW_HOST__?: WorkbenchHost;
  }
}
export function createHost(): WorkbenchHost {
  if (window.__UMEDA_PREVIEW_HOST__) return window.__UMEDA_PREVIEW_HOST__;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setInterval> }>();
  const receive = (reply: { id: string; result?: unknown; error?: string; status?: number }) => {
    const request = pending.get(reply.id); if (!request) return;
    clearTimeout(request.timer); if (request.retry) clearInterval(request.retry);
    pending.delete(reply.id); if (reply.error) request.reject(Object.assign(new Error(reply.error), { status: reply.status })); else request.resolve(reply.result);
  };
  const native = !!window.ReactNativeWebView;
  let channel: BroadcastChannel | undefined;
  if (native) window.umedaWorkbenchReply = receive;
  else { channel = new BroadcastChannel('umeda-kos-v1'); channel.onmessage = event => {
    if (event.data?.event === 'library-state') window.dispatchEvent(new CustomEvent('umeda-library-state', { detail: event.data.snapshot }));
    else receive(event.data);
  }; }
  const wake = native ? Promise.resolve() : fetch('/wake').then(response => { if (!response.ok) throw new Error('工作台暂时无法启动。'); });
  return {
    async call<T>(operation: string, payload?: unknown): Promise<T> {
      if (!native && operation === 'openExternal') {
        const url = new URL((payload as { url: string }).url);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('无法打开此链接。');
        const anchor = document.createElement('a'); anchor.href = url.href; document.body.append(anchor); anchor.click(); anchor.remove(); return undefined as T;
      }
      if (!native && ['get', 'set', 'remove'].includes(operation)) {
        const { key, value } = payload as { key: string; value?: string };
        return await localValue(operation as 'get' | 'set' | 'remove', key, value) as T;
      }
      await wake;
      return new Promise<T>((resolve, reject) => {
        const id = uniqueId(), message = { id, operation, payload };
        const timer = setTimeout(() => { const request = pending.get(id); if (request?.retry) clearInterval(request.retry); pending.delete(id); reject(new Error('请求超时，未保存的内容仍保留在本机。')); }, 120_000);
        const send = () => native ? window.ReactNativeWebView!.postMessage(JSON.stringify(message)) : channel!.postMessage(message);
        pending.set(id, { resolve: value => resolve(value as T), reject, timer, ...(!native ? { retry: setInterval(send, 500) } : {}) });
        send();
      });
    },
  };
}
import { localValue } from './localStorage';

const leaveHandlers = new Set<() => Promise<unknown>>();
export function beforeLeave(handler: () => Promise<unknown>): () => void { leaveHandlers.add(handler); return () => { leaveHandlers.delete(handler); }; }
export async function flushBeforeLeave(): Promise<void> { await Promise.all([...leaveHandlers].map(handler => handler())); }
