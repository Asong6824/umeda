import { workbenchReplyScript } from './bridge';
import { subscribeVaultChanges } from './events';
import { vaultStorageScope } from './scope';
import { mobileLibrary } from './runtime';
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import WebView, { type WebViewMessageEvent } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stack, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { getActiveSelfHostedRelay } from '@/device-link/selfHostedRelayRouting';
import { useSelfHostedRelayRouteGeneration } from '@/device-link/selfHostedRelay';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent, subscribeMobileAuthOwner } from '@/auth/authOwnerGeneration';
import { SimpleStackHeader } from '@/platform/chrome/SimpleStackHeader';
import { useTheme } from '@/theme';
import { Text } from '@/components/AppText';
import { KOS_WORKBENCH_HTML } from '../../../../packages/kos-workbench/generated/mobile';
import { validCardAiRequest } from '../../../../packages/kos-workbench/src/cards/actions';

/** The embedded UI only receives a scoped HTTP and storage port, never filesystem or credentials. */
export default function WorkbenchScreen() {
  const { t, i18n } = useTranslation(), router = useRouter(), { colors, mode } = useTheme();
  const owner = useSyncExternalStore(subscribeMobileAuthOwner, getMobileAuthOwner), generation = useSelfHostedRelayRouteGeneration();
  const webview = useRef<WebView>(null), mounted = useRef(true), ready = useRef(false);
  const route = getActiveSelfHostedRelay();
  const goHome = () => { if (router.canGoBack()) router.back(); else router.replace('/'); };
  const scope = useMemo(() => route ? vaultStorageScope(owner.accountKey, route) : '', [owner.accountKey, generation]);
  const source = useMemo(() => ({ html: KOS_WORKBENCH_HTML, baseUrl: 'https://umeda-workbench.invalid/' }), []);
  const boot = `window.__UMEDA_BOOT__=${JSON.stringify({ platform: 'mobile', theme: mode, locale: i18n.language, hostLibrary: true })};true;`;
  useEffect(() => {
    mounted.current = true;
    const subscription = AppState.addEventListener('change', state => { webview.current?.injectJavaScript(state === 'active' ? "window.dispatchEvent(new Event('umeda-resume'));true;" : "window.dispatchEvent(new Event('umeda-pause'));true;"); });
    return () => { mounted.current = false; subscription.remove(); };
  }, []);
  useEffect(() => { webview.current?.injectJavaScript(`document.documentElement.dataset.theme=${JSON.stringify(mode)};true;`); }, [mode]);
  const valid = () => mounted.current && isMobileAuthOwnerCurrent(owner) && getActiveSelfHostedRelay()?.baseUrl === route?.baseUrl && getActiveSelfHostedRelay()?.relayId === route?.relayId;
  useEffect(() => {
    const library = mobileLibrary();
    if (!library) return;
    return library.service.subscribe(() => {
      if (valid() && ready.current) {
        const data = JSON.stringify(library.service.getSnapshot()).replace(/</g, '\\u003c');
        webview.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('umeda-library-state',{detail:${data}}));true;`);
      }
    });
  }, [owner, scope, generation]);
  useEffect(() => subscribeVaultChanges((vaultId, revision) => {
    if (valid() && AppState.currentState === 'active') webview.current?.injectJavaScript(`window.dispatchEvent(new CustomEvent('umeda-vault-change',{detail:${JSON.stringify({ vaultId, revision })}}));true;`);
  }), [owner, scope, generation]);
  const handle = async (event: WebViewMessageEvent) => {
    let id: string | undefined;
    try {
      const message = JSON.parse(event.nativeEvent.data) as { id: string; operation: string; payload?: Record<string, unknown> };
      id = message.id;
      if (!valid() || typeof id !== 'string' || id.length > 160 || !route || route.authMode !== 'none') throw new Error('unavailable');
      const payload = message.payload ?? {};
      let result: unknown;
      let taskDraft: string | undefined;
      if (message.operation === 'library') {
        const library = mobileLibrary();
        if (!library) throw new Error('unavailable');
        result = await library.call(payload);
      }
      else if (message.operation === 'cardAi') {
        if (!validCardAiRequest(payload)) throw new Error('invalid');
        // The normal task composer owns device/model selection and explicit sending.
        taskDraft = payload.prompt;
        result = { disposition: 'draft' };
      }
      else if (message.operation === 'info') result = { namespace: scope, platform: 'mobile' };
      else if (['get', 'set', 'remove'].includes(message.operation)) {
        if (typeof payload.key !== 'string' || payload.key.length > 2200) throw new Error('invalid');
        const key = `umeda.workbench.v1.${scope}.${payload.key}`;
        if (message.operation === 'get') result = await AsyncStorage.getItem(key);
        else if (message.operation === 'remove') await AsyncStorage.removeItem(key);
        else {
          if (typeof payload.value !== 'string' || payload.value.length > 4 * 1024 * 1024) throw new Error('invalid');
          await AsyncStorage.setItem(key, payload.value);
        }
      } else if (message.operation === 'http') {
        if (AppState.currentState !== 'active') throw new Error('paused');
        if (typeof payload.path !== 'string' || !/^\/api\/vaults(?:[/?]|$)/.test(payload.path) || payload.path.includes('..') || payload.path.length > 5000) throw new Error('invalid');
        const method = typeof payload.method === 'string' ? payload.method : 'GET';
        if (!['GET', 'PUT', 'DELETE'].includes(method) || (payload.body !== undefined && (typeof payload.body !== 'string' || payload.body.length > 256 * 1024))) throw new Error('invalid');
        const headers: Record<string, string> = {}, proposed = payload.headers as Record<string, unknown> | undefined;
        for (const key of ['x-vault-base-revision', 'content-type']) if (typeof proposed?.[key] === 'string') headers[key] = proposed[key];
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 90_000);
        try {
          const response = await fetch(route.baseUrl + payload.path, { method, headers, body: typeof payload.body === 'string' ? payload.body : undefined, signal: controller.signal });
          if (Number(response.headers.get('content-length')) > 4 * 1024 * 1024) throw new Error('large');
          const body = await response.text();
          if (body.length > 4 * 1024 * 1024) throw new Error('large');
          result = { status: response.status, body };
        } finally { clearTimeout(timer); }
      } else if (message.operation === 'openExternal') {
        const url = new URL(String(payload.url));
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid');
        await Linking.openURL(url.href);
      } else if (message.operation === 'navigateHome') { goHome(); return; }
      else throw new Error('invalid');
      if (valid()) webview.current?.injectJavaScript(workbenchReplyScript({ id, result }));
      if (taskDraft && valid()) router.push({ pathname: '/sessions/new', params: { draft: taskDraft } });
    } catch (error) {
      const status = (error as { status?: unknown })?.status;
      const message = error instanceof Error && error.message === 'LIBRARY_OFFLINE_SIZE_LIMIT' ? error.message : t('files.vault.readError');
      if (id && valid()) webview.current?.injectJavaScript(workbenchReplyScript({ id, error: message, ...(typeof status === 'number' && Number.isInteger(status) ? { status } : {}) }));
    }
  };
  return <View style={[styles.root, { backgroundColor: colors.surface }]}>
    <Stack.Screen options={{ gestureEnabled: false }} />
    <SimpleStackHeader title="KOS" onBack={() => {
      if (route?.authMode === 'none' && ready.current) webview.current?.injectJavaScript("if(window.umedaWorkbenchClose){void window.umedaWorkbenchClose();}else{window.ReactNativeWebView.postMessage(JSON.stringify({id:'leave',operation:'navigateHome'}));}true;");
      else goHome();
    }} />
    {route?.authMode === 'none' ? <WebView key={`${scope}:${owner.generation}:${generation}`} ref={webview} source={source} style={styles.webview}
      onLoadStart={() => { ready.current = false; }} onLoad={() => { ready.current = true; }} onError={() => { ready.current = false; }}
      onContentProcessDidTerminate={() => { ready.current = false; webview.current?.reload(); }}
      injectedJavaScriptBeforeContentLoaded={boot} onMessage={event => { void handle(event); }}
      originWhitelist={['*']} onShouldStartLoadWithRequest={request => request.url === 'about:blank' || request.url.startsWith('https://umeda-workbench.invalid/')
        || (request.isTopFrame === false && (request.url === 'about:srcdoc' || request.url.startsWith('blob:https://umeda-workbench.invalid/')))}
      allowFileAccess={false} allowFileAccessFromFileURLs={false} allowUniversalAccessFromFileURLs={false} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false}
      setSupportMultipleWindows={false} javaScriptCanOpenWindowsAutomatically={false} automaticallyAdjustContentInsets={false} />
      : <Text>{t('files.vault.empty')}</Text>}
  </View>;
}
const styles = StyleSheet.create({ root: { flex: 1 }, webview: { flex: 1, backgroundColor: 'transparent' } });
