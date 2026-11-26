// @vitest-environment jsdom
/** Unit: mount the production native KOS screen and deliver actual bridge messages.
 * A cold deep link has no prior route, so router.back() silently did nothing.
 * vaultReader.test.ts is node-only and cannot cover the native header/bridge.
 * Minimal input: mounted screen, no navigation history, then a leave message.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  owner: { accountId: 'owner', accountKey: 'owner', generation: 1 },
  route: { authMode: 'none' as const, baseUrl: 'https://relay.invalid', relayId: 'relay' },
  props: {} as Record<string, any>,
  onBack: undefined as undefined | (() => void),
  hasHistory: false,
  back: vi.fn(), push: vi.fn(), replace: vi.fn(), inject: vi.fn(), storage: new Map<string, string>(),
  reload: vi.fn(), library: null as null | { call: (input: unknown) => Promise<unknown>; service: { subscribe: (listener: () => void) => () => void } },
}));
vi.mock('react-native', () => ({
  View: ({ children }: { children: unknown }) => children,
  StyleSheet: { create: (value: unknown) => value },
  Linking: { openURL: vi.fn() },
  AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
}));
vi.mock('react-native-webview', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return { default: forwardRef((props, ref) => {
    h.props = props as Record<string, any>;
    useImperativeHandle(ref, () => ({ injectJavaScript: h.inject, reload: h.reload }));
    return null;
  }) };
});
vi.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useRouter: () => ({ canGoBack: () => h.hasHistory, back: h.back, push: h.push, replace: h.replace }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }) }));
vi.mock('@/platform/chrome/SimpleStackHeader', () => ({ SimpleStackHeader: ({ onBack }: { onBack: () => void }) => { h.onBack = onBack; return null; } }));
vi.mock('@/theme', () => ({ useTheme: () => ({ colors: { surface: 'white' }, mode: 'light' }) }));
vi.mock('@/components/AppText', () => ({ Text: () => null }));
vi.mock('@/device-link/selfHostedRelayRouting', () => ({ getActiveSelfHostedRelay: () => h.route }));
vi.mock('@/device-link/selfHostedRelay', () => ({ useSelfHostedRelayRouteGeneration: () => 1 }));
vi.mock('@/vault/runtime', () => ({ mobileLibrary: () => h.library }));
vi.mock('@/auth/authOwnerGeneration', () => ({
  getMobileAuthOwner: () => h.owner,
  isMobileAuthOwnerCurrent: (owner: unknown) => owner === h.owner,
  subscribeMobileAuthOwner: () => () => {},
}));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => h.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { h.storage.set(key, value); },
  removeItem: async (key: string) => { h.storage.delete(key); },
} }));
// This test exercises the native screen, not the separately tested browser bundle.
vi.mock('../../../../packages/kos-workbench/generated/mobile', () => ({ KOS_WORKBENCH_HTML: '<html></html>' }));
import WorkbenchScreen from '@/vault/WorkbenchScreen';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
beforeEach(async () => {
  h.push.mockClear(); h.hasHistory = false; h.back.mockClear(); h.replace.mockClear(); h.inject.mockClear(); h.storage.clear();
  h.library = null; h.reload.mockClear();
  h.route = { authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'relay' };
  root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(WorkbenchScreen)));
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
const message = async (operation: string, payload?: unknown) => {
  await act(async () => h.props.onMessage({ nativeEvent: { data: JSON.stringify({ id: 'test', operation, payload }) } }));
};

it('returns to the home route after a flushed cold deep-link screen requests leave', async () => {
  act(() => h.props.onLoad());
  act(() => h.onBack?.());
  expect(h.inject).toHaveBeenLastCalledWith(expect.stringContaining('umedaWorkbenchClose'));
  await message('navigateHome');
  expect(h.replace).toHaveBeenCalledWith('/');
  expect(h.back).not.toHaveBeenCalled();
});
it('uses the existing previous route after a normally pushed screen requests leave', async () => {
  h.hasHistory = true;
  await message('navigateHome');
  expect(h.back).toHaveBeenCalledOnce(); expect(h.replace).not.toHaveBeenCalled();
});
it('can leave an unloaded cold screen without waiting for JavaScript', () => {
  act(() => h.onBack?.());
  expect(h.replace).toHaveBeenCalledWith('/');
});
// Unit / U02,U05: the new domain bridge must call the app-owned service, not a view KV queue;
// a killed WebKit process reloads the view while the service remains owned by the app.
it('dispatches domain edits to the host and reloads a terminated content process', async () => {
  const saved = { saved: '# 中文 <tag>\\u003c' }, call = vi.fn(async () => saved);
  h.library = { call, service: { subscribe: () => () => {} } };
  const command = { command: 'saveText', args: { vaultId: 'notes', path: 'note.md', text: saved.saved, baseRevision: 1 } };
  await message('library', command);
  expect(call).toHaveBeenCalledWith(command);
  const reply = vi.fn(); Function('window', h.inject.mock.lastCall![0])({ umedaWorkbenchReply: reply });
  expect(reply).toHaveBeenCalledWith({ id: 'test', result: saved });
  act(() => h.props.onContentProcessDidTerminate());
  expect(h.reload).toHaveBeenCalledOnce();
});
it('passes exact Markdown through the native HTTP reply and discards an old-route response', async () => {
  const body = '# Example\n<div>HTML</div>\n\\u003c';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
  await message('http', { path: '/api/vaults/notes/file?path=note.md' });
  const reply = vi.fn();
  Function('window', h.inject.mock.lastCall![0])({ umedaWorkbenchReply: reply });
  expect(reply).toHaveBeenCalledWith({ id: 'test', result: { status: 200, body } });
  let release!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
  h.inject.mockClear(); await message('http', { path: '/api/vaults' });
  h.route = { authMode: 'none', baseUrl: 'https://different.invalid', relayId: 'other' };
  await act(async () => release(Response.json({ vaults: [] })));
  expect(h.inject).not.toHaveBeenCalled();
});

// Unit: a whiteboard action prepares the existing task composer; it must not start
// a paid model request, choose a device, or submit invalid/oversized content.
it('hands selected knowledge to the normal task composer after acknowledging the bridge', async () => {
  await message('cardAi', { requestId: 'whiteboard-action', title: 'Summary', prompt: 'Summarize my selected notes' });
  expect(h.inject).toHaveBeenLastCalledWith(expect.stringContaining('"disposition":"draft"'));
  expect(h.push).toHaveBeenCalledWith({ pathname: '/sessions/new', params: { draft: 'Summarize my selected notes' } });
  h.push.mockClear();
  await message('cardAi', { requestId: '../invalid', title: 'Bad', prompt: 'Do not send' });
  expect(h.push).not.toHaveBeenCalled();
});
