import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { splitMarkdown } from '../../documents';
import type { ReaderAdapter, ReaderAdapterMount, ReaderAnnotation } from '../model';
import { readerSearchMatches, readerContextText } from '../model';
import { selectionWithin } from './selection';

export class MarkdownReaderAdapter implements ReaderAdapter {
  readonly kind = 'markdown' as const;
  constructor(private readonly text: string, private readonly onLink: (reference: string) => void, private readonly resolveImage?: (reference: string) => Promise<string | null>) {}
  async mount(input: ReaderAdapterMount) {
    const body = splitMarkdown(this.text).body;
    const markdown = body.replace(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, (_, path: string) => `![](${encodeURI(path)})`).replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path: string, label?: string) => `[${label ?? path}](${encodeURI(path.replace(/\.md$/, ''))})`);
    const html = DOMPurify.sanitize(await marked.parse(markdown), { FORBID_TAGS: ['script', 'iframe', 'object', 'form', 'style'], FORBID_ATTR: ['style'], ALLOW_DATA_ATTR: false });
    let annotations = input.annotations ?? [];
    let closed = false;
    let pendingAnnotationRender = false;
    const imageUrls = new Map<string, Promise<string | null>>();
    const render = () => {
      const template = document.createElement('template'); template.innerHTML = html;
      for (const image of template.content.querySelectorAll('img')) {
        const reference = image.getAttribute('src'); image.removeAttribute('src');
        if (!reference || !this.resolveImage) continue;
        let value = imageUrls.get(reference);
        if (!value) { value = this.resolveImage(reference).catch(() => null); imageUrls.set(reference, value); }
        void value.then(url => { if (url && !closed) image.src = url; });
      }
      input.container.replaceChildren(template.content);
      input.container.classList.add('markdown-content');
      for (const [index, heading] of [...input.container.querySelectorAll('h1,h2,h3,h4')].entries()) heading.id = `heading-${index}`;
      for (const annotation of annotations) {
        if (annotation.anchor.format !== 'markdown') continue;
        const quote = annotation.anchor.quote, walker = document.createTreeWalker(input.container, NodeFilter.SHOW_TEXT);
        let node: Text | null;
        while ((node = walker.nextNode() as Text | null)) {
          const index = node.data.indexOf(quote);
          if (index < 0 || node.parentElement?.closest('mark')) continue;
          const selected = node.splitText(index); selected.splitText(quote.length);
          const mark = document.createElement('mark'); mark.className = `reader-highlight is-${annotation.color}`; mark.dataset.annotationId = annotation.id;
          selected.parentNode!.insertBefore(mark, selected); mark.append(selected); break;
        }
      }
    };
    render();
    const emit = () => input.onState({ location: `scroll:${Math.round(input.container.parentElement?.scrollTop ?? 0)}`, progress: null, positionLabel: '', canNext: false, canPrevious: false,
      toc: [...input.container.querySelectorAll('h1,h2,h3,h4')].map((heading, i) => ({ id: `heading-${i}`, label: heading.textContent ?? '', target: `heading-${i}`, depth: Number(heading.tagName[1]) - 1 })) });
    const click = (event: MouseEvent) => {
      const link = (event.target as Element).closest('a'); if (!link) return;
      event.preventDefault(); this.onLink(link.getAttribute('href') ?? '');
    };
    const selection = () => {
      const selected = selectionWithin(input.container, 'markdown', '');
      input.onSelection(selected ? { ...selected, anchor: { format: 'markdown', quote: selected.text } } : null);
      if (!selected && pendingAnnotationRender && !closed) {
        pendingAnnotationRender = false;
        const top = scroller?.scrollTop ?? 0; render(); if (scroller) scroller.scrollTop = top;
      }
    };
    const scroller = input.container.parentElement;
    const scroll = () => emit();
    input.container.addEventListener('click', click); document.addEventListener('selectionchange', selection); scroller?.addEventListener('scroll', scroll, { passive: true });
    if (input.initialLocation?.startsWith('scroll:') && scroller) requestAnimationFrame(() => { scroller.scrollTop = Number(input.initialLocation!.slice(7)) || 0; });
    emit();
    return {
      previous: async () => undefined, next: async () => undefined,
      goTo: async (target: string) => {
        if (target.startsWith('search:')) {
          const [, rawIndex, ...encoded] = target.split(':'), occurrence = Number(rawIndex), query = decodeURIComponent(encoded.join(':'));
          render();
          const walker = document.createTreeWalker(input.container, NodeFilter.SHOW_TEXT);
          let node: Text | null, seen = 0;
          while ((node = walker.nextNode() as Text | null)) {
            let from = 0;
            while (query && from < node.length) {
              const index = node.data.toLocaleLowerCase().indexOf(query.toLocaleLowerCase(), from);
              if (index < 0) break;
              if (seen++ === occurrence) {
                const selected = node.splitText(index); selected.splitText(query.length);
                const mark = document.createElement('mark'); mark.className = 'reader-search-result';
                selected.parentNode!.insertBefore(mark, selected); mark.append(selected); mark.scrollIntoView({ block: 'center' }); return;
              }
              from = index + query.length;
            }
          }
          return;
        }
        const element = target.startsWith('annotation:') ? input.container.querySelector(`[data-annotation-id="${CSS.escape(target.slice(11))}"]`) : input.container.querySelector(`#${CSS.escape(target)}`);
        element?.scrollIntoView({ block: 'center' });
      },
      search: async (query: string) => readerSearchMatches(input.container.innerText, query, 'markdown', '').map((match, index) => ({ ...match, location: `search:${index}:${encodeURIComponent(query)}` })),
      getContext: async () => ({ text: readerContextText(input.container.innerText), location: 'markdown', positionLabel: '' }),
      setAnnotations: async (next: ReaderAnnotation[]) => {
        annotations = next;
        // A late reading-record refresh must not erase a live excerpt selection.
        if (selectionWithin(input.container, 'markdown', '')) { pendingAnnotationRender = true; return; }
        pendingAnnotationRender = false;
        const top = scroller?.scrollTop ?? 0; render(); if (scroller) scroller.scrollTop = top;
      },
      close: () => { closed = true; for (const value of imageUrls.values()) void value.then(url => { if (url) URL.revokeObjectURL(url); }); document.removeEventListener('selectionchange', selection); input.container.removeEventListener('click', click); scroller?.removeEventListener('scroll', scroll); input.container.replaceChildren(); },
    };
  }
}
