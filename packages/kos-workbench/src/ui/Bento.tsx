import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type PointerEvent } from 'react';
import { normalizeBentoLayout, resolveBentoLayout, moveBentoItem, resizeBentoItem, type BentoLayoutItem, type DashboardCardId, type BentoMinimumRows } from '../core/bento-layout';
import { Icon } from './Icons';
import { WORKBENCH_LAYOUT, MOBILE_CARD_ORDER } from './layout';
import { t } from '../messages';

function Card({ item, editing, onMeasure, onPointerDown, mobile, order, onMove, children }: {
  mobile: boolean; order: number; onMove(delta: number): void;
  item: BentoLayoutItem; editing: boolean; onMeasure(id: DashboardCardId, rows: number): void;
  onPointerDown(item: BentoLayoutItem, resize: boolean, event: PointerEvent<HTMLButtonElement>): void; children: ReactNode;
}) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!content.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame); frame = requestAnimationFrame(() => { if (content.current) onMeasure(item.id, Math.ceil((content.current.scrollHeight + 48 + 16) / 58)); });
    });
    observer.observe(content.current);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [item.id, onMeasure]);
  return <section id={`section-${item.id}`} className={`bento-card card-${item.id}${editing ? ' editing' : ''}`}
    style={{ '--mobile-order': order, gridColumn: `${item.x + 1} / span ${item.w}`, gridRow: `${item.y + 1} / span ${item.h}` } as React.CSSProperties}>
    {editing && !mobile && <button className="layout-grip icon-button" aria-label={`${t('move')} ${t(item.id)}`} onPointerDown={event => onPointerDown(item, false, event)}><Icon name="grip" /></button>}
    {editing && mobile && <div className="mobile-card-controls"><button className="icon-button" disabled={order === 0} aria-label={`${t('move')} ${t(item.id)} ↑`} onClick={() => onMove(-1)}>↑</button><button className="icon-button" disabled={order === MOBILE_CARD_ORDER.length - 1} aria-label={`${t('move')} ${t(item.id)} ↓`} onClick={() => onMove(1)}>↓</button></div>}
    <div ref={content}>{children}</div>
    {editing && !mobile && <button className="layout-resize icon-button" aria-label={`${t('resize')} ${t(item.id)}`} onPointerDown={event => onPointerDown(item, true, event)}><Icon name="resize" /></button>}
  </section>;
}
export function Bento({ initial, mobileOrder, persistMobileOrder, render, persist }: { mobileOrder: DashboardCardId[]; persistMobileOrder(order: DashboardCardId[]): Promise<void>; initial: BentoLayoutItem[] | null; render(id: DashboardCardId): ReactNode; persist(layout: BentoLayoutItem[]): Promise<void> }) {
  const [mobile, setMobile] = useState(() => matchMedia('(max-width:760px)').matches);
  const [mobileHistory, setMobileHistory] = useState<DashboardCardId[][]>([]), [mobileRedo, setMobileRedo] = useState<DashboardCardId[][]>([]);
  const order = Array.isArray(mobileOrder) && mobileOrder.length === MOBILE_CARD_ORDER.length && new Set(mobileOrder).size === MOBILE_CARD_ORDER.length && MOBILE_CARD_ORDER.every(id => mobileOrder.includes(id)) ? mobileOrder : MOBILE_CARD_ORDER;
  useEffect(() => { const query = matchMedia('(max-width:760px)'), update = () => setMobile(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  const reorder = (next: DashboardCardId[]) => { setMobileHistory(history => [...history.slice(-19), [...order]]); setMobileRedo([]); void persistMobileOrder(next); };
  const [layout, setLayout] = useState(() => normalizeBentoLayout(initial ?? WORKBENCH_LAYOUT));
  const [editing, setEditing] = useState(false), [minimums, setMinimums] = useState<BentoMinimumRows>({});
  const [undo, setUndo] = useState<BentoLayoutItem[][]>([]), [redo, setRedo] = useState<BentoLayoutItem[][]>([]);
  const grid = useRef<HTMLDivElement>(null), current = useRef(layout), first = useRef(true);
  current.current = layout;
  useEffect(() => { if (initial && first.current) { first.current = false; setLayout(normalizeBentoLayout(initial)); } }, [initial]);
  const measured = useCallback((id: DashboardCardId, rows: number) => setMinimums(previous => previous[id] === rows ? previous : { ...previous, [id]: rows }), []);
  const resolved = resolveBentoLayout(layout, minimums);
  const commit = (next: BentoLayoutItem[], previous = current.current) => {
    if (JSON.stringify(next) === JSON.stringify(previous)) return;
    setUndo(history => [...history.slice(-19), previous]); setRedo([]); setLayout(next); void persist(next);
  };
  const begin = (item: BentoLayoutItem, resize: boolean, event: PointerEvent<HTMLButtonElement>) => {
    if (!grid.current) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const target = event.currentTarget, base = current.current, startX = event.clientX, startY = event.clientY;
    const stepX = (grid.current.clientWidth + 16) / 12, stepY = 58;
    let next = base;
    const move = (event: globalThis.PointerEvent) => {
      const dx = Math.round((event.clientX - startX) / stepX), dy = Math.round((event.clientY - startY) / stepY);
      next = resize ? resizeBentoItem(base, item.id, item.w + dx, item.h + dy, minimums) : moveBentoItem(base, item.id, item.x + dx, item.y + dy, minimums);
      setLayout(next);
    };
    const finish = (event: globalThis.PointerEvent) => {
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', finish); target.removeEventListener('pointercancel', cancel);
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      commit(next, base);
    };
    const cancel = (event: globalThis.PointerEvent) => { next = base; finish(event); setLayout(base); };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', finish); target.addEventListener('pointercancel', cancel);
  };
  return <>
    <div className="layout-toolbar">
      {editing && <>
        {mobile ? <>
        <button disabled={!mobileHistory.length} onClick={() => { const previous = mobileHistory.at(-1)!; setMobileRedo(history => [...history, [...order]]); setMobileHistory(mobileHistory.slice(0, -1)); void persistMobileOrder(previous); }}>{t('undo')}</button>
        <button disabled={!mobileRedo.length} onClick={() => { const next = mobileRedo.at(-1)!; setMobileHistory(history => [...history, [...order]]); setMobileRedo(mobileRedo.slice(0, -1)); void persistMobileOrder(next); }}>{t('redo')}</button>
        <button onClick={() => reorder([...MOBILE_CARD_ORDER])}>{t('resetLayout')}</button>
        </> : <>
        <button disabled={!undo.length} onClick={() => { const previous = undo.at(-1)!; setRedo(history => [...history, layout]); setUndo(undo.slice(0, -1)); setLayout(previous); void persist(previous); }}>{t('undo')}</button>
        <button disabled={!redo.length} onClick={() => { const next = redo.at(-1)!; setUndo(history => [...history, layout]); setRedo(redo.slice(0, -1)); setLayout(next); void persist(next); }}>{t('redo')}</button>
        <button onClick={() => commit(normalizeBentoLayout(WORKBENCH_LAYOUT))}>{t('resetLayout')}</button>
        </>}
      </>}
      <button aria-pressed={editing} onClick={() => setEditing(!editing)}><Icon name="grid" />{t(editing ? 'finishLayout' : 'layout')}</button>
    </div>
    <div ref={grid} className="bento-grid">{resolved.map(item => <Card key={item.id} item={item} mobile={mobile} order={order.indexOf(item.id)} onMove={delta => { const index = order.indexOf(item.id), next = [...order]; [next[index], next[index + delta]] = [next[index + delta], next[index]]; reorder(next); }} editing={editing} onMeasure={measured} onPointerDown={begin}>{render(item.id)}</Card>)}</div>
  </>;
}
