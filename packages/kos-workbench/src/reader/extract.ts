import * as pdfjs from 'pdfjs-dist';
import ePub from 'epubjs';
import type { BookTextPart } from '../library/model';

function check(signal: AbortSignal) { if (signal.aborted) throw new DOMException('Indexing stopped', 'AbortError'); }
async function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  check(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new DOMException('Indexing stopped', 'AbortError')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
function* chunks(text: string, location: string, label: string): Generator<BookTextPart> {
  // Bound bridge messages even for a book with a single extremely long chapter.
  if (!text) { yield { text: '', location, label }; return; }
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(text.length, offset + 16000);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    yield { text: text.slice(offset, end), location, label }; offset = end;
  }
}

/** Derived text only. Source bytes have already passed the host/client SHA check.
 * No rendering, OCR, CDN or remote book URLs. Resources are released on cancel/close.
 */
export async function* extractBookText(bytes: Uint8Array, kind: 'pdf' | 'epub', signal: AbortSignal): AsyncGenerator<BookTextPart> {
  check(signal);
  if (kind === 'pdf') {
    const task = pdfjs.getDocument({ data: bytes });
    const cancel = () => { void task.destroy(); }; signal.addEventListener('abort', cancel, { once: true });
    try {
      const pdf = await task.promise;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        check(signal); const page = await pdf.getPage(pageNumber);
        try {
          const content = await page.getTextContent(); check(signal);
          const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
          yield* chunks(text, `page:${pageNumber}`, String(pageNumber));
        } finally { page.cleanup(); }
      }
    } finally { signal.removeEventListener('abort', cancel); await task.destroy(); }
  } else {
    const book = ePub({ replacements: 'none', requestMethod: () => Promise.reject(new Error('EXTERNAL_BOOK_RESOURCE')) });
    try {
      await wait(book.open(bytes.slice().buffer as ArrayBuffer), signal); check(signal);
      const spine = await book.loaded.spine;
      for (let index = 0; index < spine.length; index++) {
        check(signal); const section = book.section(index);
        try {
          await wait(Promise.resolve(section.load(book.load.bind(book))), signal); check(signal);
          // XML DOMs do not execute scripts or fetch images. Remove non-reading text.
          const node = section.document.documentElement.cloneNode(true) as Element;
          node.querySelectorAll('script,style,head').forEach(item => item.remove());
          const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
          yield* chunks(text, section.href, String(index + 1));
        } finally { section.unload(); }
      }
    } finally { book.destroy(); }
  }
}
