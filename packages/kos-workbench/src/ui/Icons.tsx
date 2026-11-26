import type { SVGProps } from 'react';
export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: string }) {
  const paths: Record<string, string> = {
    plus: 'M12 5v14M5 12h14', close: 'M6 6l12 12M6 18L18 6', back: 'M15 5l-7 7 7 7',
    search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', edit: 'M16 3l5 5-12 12H4v-5z',
    refresh: 'M20 8a8 8 0 1 0 0 8M20 3v5h-5', check: 'M4 12l5 5L20 6',
    book: 'M3 3h7c2 0 2 2 2 2s0-2 2-2h7v17h-7c-2 0-2 2-2 2s0-2-2-2H3zM12 5v17',
    folder: 'M3 5h7l2 3h9v12H3z', grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    clock: 'M12 7v5l4 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
    grip: 'M8 4v1m0 6v1m0 6v1m8-15v1m0 6v1m0 6v1',
    undo: 'M9 5L3 11l6 6M3 11h11a6 6 0 0 1 0 12', resize: 'M10 20l10-10M16 20l4-4',
    note: 'M5 3h14v18H5zM8 8h8M8 12h8M8 16h5',
    settings: 'M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6',
  };
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name] ?? paths.note} /></svg>;
}
