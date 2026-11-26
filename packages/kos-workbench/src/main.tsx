import { createRoot } from 'react-dom/client';
import { KnowledgeApp } from './ui/KnowledgeApp';
import { createHost, flushBeforeLeave } from './host';
import { WorkbenchStore } from './store';
import { LibraryClient } from './library/client';
import type { WorkbenchSnapshot } from './library/service';
import { setLocale } from './messages';

// Plugin CSP permits bundled scripts, not inline bootstrap scripts in HTML.
if (!window.__UMEDA_BOOT__ && location.protocol === 'cindy-ghost:') {
  window.__UMEDA_BOOT__ = { platform: 'desktop', locale: navigator.language, theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', hostLibrary: true };
}
const boot = window.__UMEDA_BOOT__;
if (location.protocol === 'cindy-ghost:') document.documentElement.dataset.desktopHost = 'true';
setLocale(boot?.locale ?? navigator.language);
document.documentElement.dataset.theme = boot?.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
const host = createHost();
const store = boot?.hostLibrary ? new LibraryClient(host, listener => {
  const receive = (event: Event) => listener((event as CustomEvent<WorkbenchSnapshot>).detail);
  window.addEventListener('umeda-library-state', receive);
  return () => window.removeEventListener('umeda-library-state', receive);
}) : new WorkbenchStore(host);
const root = createRoot(document.getElementById('root')!);
root.render(<KnowledgeApp store={store} />);
window.addEventListener('beforeunload', () => { root.unmount(); store.dispose(); });

window.umedaWorkbenchClose = async () => {
  try { await flushBeforeLeave(); await host.call('navigateHome'); }
  catch { window.dispatchEvent(new Event('umeda-save-error')); }
};

// Electron applies host theme tokens with insertCSS, so native control appearance must follow it.
if (location.protocol === 'cindy-ghost:') {
  const syncTheme = () => {
    if (document.visibilityState === 'hidden') return;
    const scheme = getComputedStyle(document.documentElement).colorScheme;
    if ((scheme === 'dark' || scheme === 'light') && document.documentElement.dataset.theme !== scheme) document.documentElement.dataset.theme = scheme;
  };
  syncTheme(); const timer = setInterval(syncTheme, 1000);
  window.addEventListener('beforeunload', () => clearInterval(timer));
}
