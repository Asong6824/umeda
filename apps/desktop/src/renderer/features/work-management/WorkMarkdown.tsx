import { memo, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import type { WorkItemSummary } from '@cindy/maker-shared/work-management';
import { splitWorkDescription } from './description';

const remarkPlugins = [remarkGfm, remarkCjkFriendly, remarkMath];
const rehypePlugins = [rehypeKatex];
type MarkdownNode = { type: string; value?: string; url?: string; children?: MarkdownNode[] };
const components: Components = {
  h1: ({ children }) => <h3 className="mt-6 mb-3 text-lg font-medium">{children}</h3>,
  h2: ({ children }) => <h3 className="mt-5 mb-2 text-base font-medium">{children}</h3>,
  h3: ({ children }) => <h4 className="mt-4 mb-2 text-sm font-medium">{children}</h4>,
  p: ({ children }) => <p className="my-3 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 ml-5 list-disc space-y-1">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 ml-5 list-decimal space-y-1">{children}</ol>,
  strong: ({ children }) => <strong className="font-bold">{children}</strong>,
  blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-[var(--border-default)] pl-4 text-[var(--text-secondary)]">{children}</blockquote>,
  pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-lg border border-[var(--border-default)] bg-[var(--surface-chip)] p-3 text-xs">{children}</pre>,
  code: ({ children }) => <code className="break-words font-mono text-[0.9em]">{children}</code>,
  table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full border-collapse text-sm">{children}</table></div>,
  th: ({ children }) => <th className="border border-[var(--border-default)] px-3 py-2 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border border-[var(--border-default)] px-3 py-2">{children}</td>,
  hr: () => <hr className="my-5 border-[var(--border-default)]" />,
};

/** Document typography without chat/session capabilities or filesystem access. */
export const WorkMarkdown = memo(function WorkMarkdown({ content, title, targets = [], openItem }: { content: string; title?: string; targets?: readonly WorkItemSummary[]; openItem?: (item: WorkItemSummary) => void }) {
  const body = splitWorkDescription(content).body;
  const heading = /^\s*#\s+([^\n]+)\n/.exec(body);
  const renderedBody = heading && heading[1].trim() === title ? body.slice(heading[0].length) : body;
  const plugins = useMemo(() => {
    const lookup = (value: string) => {
      const key = value.replace(/\.md$/, '').split('/').at(-1)?.trim().toLocaleLowerCase();
      const found = targets.filter(item => item.id === value || item.title.trim().toLocaleLowerCase() === key);
      return found.length === 1 ? found[0] : undefined;
    };
    const wikiLinks = () => (tree: MarkdownNode) => {
      const visit = (node: MarkdownNode) => {
        if (!node.children || ['link', 'code', 'inlineCode'].includes(node.type)) return;
        node.children = node.children.flatMap(child => {
          if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
          const pieces: MarkdownNode[] = []; let start = 0;
          for (const match of child.value.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
            pieces.push({ type: 'text', value: child.value.slice(start, match.index) });
            const [reference, alias] = match[1].split('|'), target = lookup(reference.split('#')[0]);
            const label = alias || reference;
            pieces.push(target && openItem ? { type: 'link', url: `#umeda-work-${target.id}`, children: [{ type: 'text', value: label }] } : { type: 'text', value: label });
            start = match.index! + match[0].length;
          }
          return pieces.length ? [...pieces, { type: 'text', value: child.value.slice(start) }] : [child];
        });
      }; visit(tree);
    };
    return [...remarkPlugins, wikiLinks];
  }, [targets, openItem]);
  const renderers = useMemo<Components>(() => ({ ...components,
    a: ({ href, children }) => {
      const match = /^#umeda-work-([A-Za-z0-9_-]+)$/.exec(href ?? '');
      const target = match && targets.find(item => item.id === match[1]);
      if (target && openItem) return <button type="button" className="inline rounded-sm text-left underline underline-offset-2 focus-visible:outline focus-visible:outline-[var(--focus-ring)]" onClick={() => openItem(target)}>{children}</button>;
      if (!href || !/^(https?:|mailto:)/i.test(href)) return <span>{children}</span>;
      return <a href={href} className="underline underline-offset-2" onClick={event => { event.preventDefault(); void window.electronAPI.openExternal(href); }}>{children}</a>;
    },
  }), [targets, openItem]);
  return <div className="min-w-0 break-words text-sm leading-relaxed"><ReactMarkdown skipHtml remarkPlugins={plugins} rehypePlugins={rehypePlugins} components={renderers}>{renderedBody}</ReactMarkdown></div>;
});
