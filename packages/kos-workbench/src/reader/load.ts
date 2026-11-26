import type * as Readers from './runtime';
declare global { interface Window { UmedaReaders?: typeof Readers } }
let loading: Promise<typeof Readers> | undefined;

/** Embedded resources stay offline-capable; heavy reader code is compiled only when used. */
export function loadReaders(): Promise<typeof Readers> {
  if (window.UmedaReaders) return Promise.resolve(window.UmedaReaders);
  return loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const done = () => window.UmedaReaders ? resolve(window.UmedaReaders) : reject(new Error('READER_NOT_AVAILABLE'));
    const embedded = document.getElementById('umeda-reader-code');
    script.onerror = () => { loading = undefined; reject(new Error('READER_NOT_AVAILABLE')); };
    if (embedded) {
      try { script.textContent = JSON.parse(embedded.textContent ?? '""'); document.head.append(script); done(); }
      catch (error) { loading = undefined; reject(error); }
    } else { script.src = 'reader.js'; script.onload = done; document.head.append(script); }
  });
}
