import type { BentoLayoutItem, DashboardCardId } from '../core/bento-layout';
/** Compact initial arrangement; the imported KOS collision/resize rules remain unchanged. */
export const WORKBENCH_LAYOUT: BentoLayoutItem[] = [
  { id: 'schedule', x: 0, y: 0, w: 3, h: 5 }, { id: 'goals', x: 3, y: 0, w: 5, h: 5 },
  { id: 'progress', x: 8, y: 0, w: 4, h: 5 }, { id: 'heatmap', x: 0, y: 5, w: 12, h: 3 },
  { id: 'today', x: 0, y: 8, w: 7, h: 8 }, { id: 'action', x: 7, y: 8, w: 5, h: 8 },
  { id: 'input', x: 0, y: 16, w: 6, h: 8 }, { id: 'knowledge', x: 6, y: 16, w: 6, h: 8 },
  { id: 'review', x: 0, y: 24, w: 8, h: 7 }, { id: 'system', x: 8, y: 24, w: 4, h: 7 },
];

export const MOBILE_CARD_ORDER: DashboardCardId[] = ['schedule', 'today', 'action', 'input', 'goals', 'knowledge', 'review', 'progress', 'heatmap', 'system'];
