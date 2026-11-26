import { useEffect, useRef } from 'react';

/** Keep keyboard navigation inside the current editor, and restore the opener afterward. */
export function useModalDialog(close: () => Promise<void>, enabled = true) {
  const element = useRef<HTMLElement>(null), latest = useRef(close); latest.current = close;
  useEffect(() => {
    if (!enabled) return;
    const opener = document.activeElement as HTMLElement | null;
    const focusable = () => [...(element.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter(node => node.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void latest.current(); }
      if (event.key !== 'Tab') return;
      const nodes = focusable(), active = document.activeElement, first = nodes[0], last = nodes.at(-1);
      if (!first) return;
      if (event.shiftKey && (active === first || !element.current?.contains(active))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (active === last || !element.current?.contains(active))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (opener?.isConnected) opener.focus(); };
  }, [enabled]);
  return element;
}
