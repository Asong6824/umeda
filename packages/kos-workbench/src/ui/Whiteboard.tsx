import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, ReactFlowProvider, Handle, Position, NodeResizer, Background, Controls, MarkerType, applyNodeChanges, useReactFlow, type Node, type NodeProps, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/base.css';
import type { VaultSummary } from '@cindy/device-link';
import type { LibraryModel } from '../library/model';
import { prepareCardAiAction, type CardAiAction, type CardAiReceipt, type CardAiRequest } from '../cards/actions';
import { movePlacements, selectedCards } from '../cards/geometry';
import { CardPreview } from './CardPreview';
import { CardRepository } from '../cards/repository';
import { cardRef, resolveCard, type Whiteboard as Board, type Placement } from '../cards/model';
import { displayTitle } from '../documents';
import { uniqueId, beforeLeave } from '../host';
import { t } from '../messages';

type CanvasNode = Node<{ item: Placement; file?: VaultSummary; store: LibraryModel; vaultId: string; open(file: VaultSummary): void; update(item: Placement): void }, 'card'>;
const CardNode = memo(function CardNode({ data, selected }: NodeProps<CanvasNode>) {
  const { item, file, update } = data;
  return <div className={`knowledge-node ${item.kind}${item.folded ? ' folded' : ''}`}>
    <NodeResizer isVisible={selected} minWidth={180} minHeight={item.folded ? 72 : 100} />
    <Handle type="target" position={Position.Left} />
    {item.kind === 'card' ? <>
      <header><strong>{file ? displayTitle(file) : t(item.aiRequest ? 'waitingForAi' : 'missingCard')}</strong><button className="nodrag" aria-label={t(item.folded ? 'expandCard' : 'foldCard')} onClick={() => update({ ...item, folded: !item.folded })}>{item.folded ? '+' : '−'}</button></header>
      {!item.folded && <>{!file && item.aiRequest && <p>{t('waitingAiHint')}</p>}{file && <CardPreview store={data.store} vaultId={data.vaultId} file={file} page={item.previewPage} />}{file && /\.pdf$/i.test(file.path) && <label className="pdf-preview-page nodrag">{t('pagePreview')}<input className="nodrag" type="number" min="1" aria-label={t('previewPage')} value={item.previewPage ?? 1} onChange={event => { const page = Number(event.target.value); if (Number.isSafeInteger(page) && page > 0) update({ ...item, previewPage: page }); }} /></label>}<button className="nodrag" disabled={!file} onClick={() => file && data.open(file)}>{t('open')}</button></>}
    </> : <textarea className="nodrag nowheel" aria-label={t(item.kind === 'section' ? 'sectionElement' : 'textElement')} value={item.text ?? ''} onChange={event => update({ ...item, text: event.target.value })} />}
    <Handle type="source" position={Position.Right} />
  </div>;
});
const nodeTypes = { card: CardNode };

export function Whiteboard(props: { store: LibraryModel; vaultId: string; file: VaultSummary; files: VaultSummary[]; addFile: VaultSummary | null; added(): void; open(file: VaultSummary): void; notice(message: string): void; focusCard?: string }) {
  return <ReactFlowProvider><Canvas key={`${props.vaultId}:${props.file.path}`} {...props} /></ReactFlowProvider>;
}
function Canvas({ store, vaultId, file, files, addFile, added, open, notice, focusCard }: Parameters<typeof Whiteboard>[0]) {
  const repository = useMemo(() => new CardRepository(store, vaultId), [store, vaultId]);
  const [board, setBoard] = useState<Board | null>(null), [error, setError] = useState(false), [saving, setSaving] = useState(false), [saveFailed, setSaveFailed] = useState(false);
  const [nodes, setNodes] = useState<CanvasNode[]>([]), [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const actionLock = useRef(false);
  const [undo, setUndo] = useState<Board[]>([]), [redo, setRedo] = useState<Board[]>([]);
  const current = useRef<Board | null>(null), dirty = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dragStart = useRef<Board | null>(null);
  const savingChain = useRef(Promise.resolve()), alive = useRef(true), canvasRef = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, fitView, setCenter } = useReactFlow<CanvasNode>();
  const flush = () => {
    clearTimeout(timer.current);
    if (!dirty.current || !current.current) return savingChain.current;
    const next = current.current;
    // Serial local commits; the existing host queue owns network delivery and recovery.
    const operation = savingChain.current.catch(() => {}).then(() => repository.saveBoard(file, next));
    savingChain.current = operation;
    return operation.then(() => { if (current.current === next) dirty.current = false; if (alive.current) { setSaving(false); setSaveFailed(false); } })
      .catch(error => { if (alive.current) { setSaving(false); setSaveFailed(true); notice(t('boardSaveError')); } throw error; });
  };
  useEffect(() => {
    alive.current = true;
    void repository.readBoard(file).then(value => { if (alive.current) { current.current = value; setBoard(value); } }).catch(() => { if (alive.current) setError(true); });
    return () => { alive.current = false; clearTimeout(timer.current); void flush().catch(() => {}); };
  }, [repository, file.path]);
  useEffect(() => beforeLeave(flush), [repository, file.path]);
  useEffect(() => {
    // Returning to an already-open board after using another device must show the
    // newly synchronized layout. Never replace edits still waiting for local save.
    const before = current.current;
    if (!before || dirty.current) return;
    let active = true;
    void repository.readBoard(file).then(next => {
      if (active && !dirty.current && current.current === before && JSON.stringify(next) !== JSON.stringify(before)) {
        current.current = next; setBoard(next); setUndo([]); setRedo([]);
      }
    }).catch(() => { if (active) notice(t('boardReadError')); });
    return () => { active = false; };
  }, [repository, file.revision, file.hash]);
  const commit = (next: Board, history = true) => {
    if (!current.current) return;
    if (history) { setUndo(previous => [...previous.slice(-49), current.current!]); setRedo([]); }
    current.current = next; dirty.current = true; setBoard(next); setSaving(true);
    clearTimeout(timer.current); timer.current = setTimeout(() => { void flush().catch(() => {}); }, 350);
  };
  const update = (item: Placement) => { if (current.current) commit({ ...current.current, items: current.current.items.map(value => value.id === item.id ? item : value) }); };
  useEffect(() => {
    if (!board || dragStart.current) return;
    setNodes(previous => board.items.map(item => ({ ...previous.find(node => node.id === item.id), id: item.id, type: 'card', position: { x: item.x, y: item.y },
      style: { width: item.width, height: item.folded ? 72 : item.height }, zIndex: item.kind === 'section' ? 0 : 2,
      data: { item, file: item.card ? resolveCard(item.card, files) : undefined, store, vaultId, open, update } })));
  }, [board, files]);
  useEffect(() => {
    if (!board || !focusCard) return;
    const item = board.items.find(value => value.card?.id === focusCard);
    if (item) void setCenter(item.x + item.width / 2, item.y + item.height / 2, { zoom: 1 });
  }, [!!board, focusCard]);
  const add = (kind: Placement['kind'], reference?: VaultSummary, position?: { x: number; y: number }) => {
    const value = current.current; if (!value) return;
    const bounds = canvasRef.current?.getBoundingClientRect();
    const center = position ?? screenToFlowPosition({ x: bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2, y: bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2 });
    let width = kind === 'section' ? 640 : 280, height = kind === 'section' ? 420 : 240;
    let x = center.x - width / 2, y = center.y - height / 2;
    const chosen = new Set(nodes.filter(node => node.selected).map(node => node.id));
    const content = value.items.filter(item => item.kind !== 'section' && (kind !== 'section' || !chosen.size || chosen.has(item.id)));
    if (!position && content.length) {
      if (kind === 'section') {
        x = Math.min(...content.map(item => item.x)) - 32; y = Math.min(...content.map(item => item.y)) - 70;
        width = Math.max(...content.map(item => item.x + item.width)) - x + 32;
        height = Math.max(...content.map(item => item.y + item.height)) - y + 32;
      } else {
        const last = content.at(-1)!; x = last.x + last.width + 60; y = last.y;
      }
    }
    commit({ ...value, items: [...value.items, { id: uniqueId(), kind, x, y, width, height,
      ...(reference ? { card: cardRef(reference) } : { text: t(kind === 'section' ? 'sectionElement' : 'textElement') }) }] });
  };
  useEffect(() => {
    if (!board?.items.length) return;
    const frame = requestAnimationFrame(() => { void fitView({ maxZoom: 1, padding: 0.2 }); });
    return () => cancelAnimationFrame(frame);
  }, [board?.items.length]);
  useEffect(() => { if (board && addFile) { add('card', addFile); added(); } }, [!!board, addFile]);
  useEffect(() => {
    if (!board) return;
    let changed = false;
    const items = board.items.map(item => {
      if (!item.aiRequest || !item.card?.id.startsWith('path:')) return item;
      const result = resolveCard(item.card, files);
      if (!result) return item;
      changed = true; return { ...item, card: cardRef(result) };
    });
    if (changed) commit({ ...board, items }, false);
  }, [board, files]);
  const submitAction = async (kind?: CardAiAction, retryId?: string) => {
    if (actionLock.current || !current.current) return;
    actionLock.current = true; setActionBusy(true);
    try {
      let request: CardAiRequest;
      if (retryId) {
        const saved = await store.preference<CardAiRequest | null>(`board-ai:${vaultId}:${retryId}`, null);
        if (!saved) throw new Error('AI_REQUEST_MISSING');
        request = saved;
      } else {
        const id = uniqueId();
        const title = `${t(kind === 'compare' ? 'aiCompare' : kind === 'challenge' ? 'aiChallenge' : 'aiSummarize')} · ${displayTitle(file)}`.slice(0, 100);
        const prepared = await prepareCardAiAction(store, vaultId, current.current, nodes.filter(node => node.selected).map(node => node.id), kind!, id, title);
        request = prepared.request;
        const all = current.current.items;
        const x = all.length ? Math.max(...all.map(item => item.x + item.width)) + 60 : 0;
        // Save the destination before handing work to another screen or computer.
        commit({ ...current.current, items: [...all, { id: uniqueId(), kind: 'card', card: { id: `path:${prepared.targetPath}`, path: prepared.targetPath }, aiRequest: id, x, y: all[0]?.y ?? 0, width: 320, height: 280 }] });
        await store.savePreference(`board-ai:${vaultId}:${id}`, request);
        await flush();
      }
      const receipt = await store.host.call<CardAiReceipt>('cardAi', request);
      if (!receipt || !['submitted', 'draft'].includes(receipt.disposition)) throw new Error('AI_RECEIPT_UNKNOWN');
      notice(t(receipt.disposition === 'draft' ? 'aiDraftReady' : 'aiSubmitted'));
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      notice(t(code === 'AI_REQUIRES_EXCERPTS' ? 'aiRequiresExcerpts' : code === 'AI_SELECTION_EMPTY' ? 'aiSelectCards' : code === 'AI_CONTEXT_TOO_LARGE' ? 'aiContextTooLarge' : 'aiSubmitFailed'));
    } finally { actionLock.current = false; if (alive.current) setActionBusy(false); }
  };
  const selected = nodes.filter(node => node.selected).map(node => node.id);
  const canAct = !!board && selectedCards(board, selected).length > 0;
  const retryItem = board?.items.find(item => selected.includes(item.id) && item.aiRequest && item.card && !resolveCard(item.card, files));
  const edges: Edge[] = board?.links.map(link => ({ id: link.id, source: link.from, target: link.to, zIndex: 3, label: link.label, markerEnd: { type: MarkerType.ArrowClosed } })) ?? [];
  if (error) return <div className="empty"><p>{t('boardReadError')}</p><button onClick={() => { setError(false); void repository.readBoard(file).then(value => { current.current = value; setBoard(value); }).catch(() => setError(true)); }}>{t('retry')}</button></div>;
  if (!board) return <p className="empty">{t('processing')}</p>;
  return <section className="whiteboard-editor">
    <header className="whiteboard-tools"><strong>{displayTitle(file)}</strong><span role="status">{saveFailed ? t('boardSaveError') : saving ? t('processing') : t('boardSaved')}</span>
      <button onClick={() => add('text')}>{t('addText')}</button><button onClick={() => add('section')}>{t('addSection')}</button>
      <button disabled={!undo.length} onClick={() => { const value = undo.at(-1)!; setRedo(previous => [...previous, current.current!]); setUndo(previous => previous.slice(0, -1)); commit(value, false); }}>{t('undo')}</button>
      <button disabled={!redo.length} onClick={() => { const value = redo.at(-1)!; setUndo(previous => [...previous, current.current!]); setRedo(previous => previous.slice(0, -1)); commit(value, false); }}>{t('redo')}</button>
      <button onClick={() => { void flush().catch(() => {}); }}>{t('save')}</button>
      {(['summarize', 'compare', 'challenge'] as const).map(kind => <button key={kind} disabled={!canAct || actionBusy} onClick={() => void submitAction(kind)}>{t(kind === 'compare' ? 'aiCompare' : kind === 'challenge' ? 'aiChallenge' : 'aiSummarize')}</button>)}
      {retryItem && <button disabled={actionBusy} onClick={() => void submitAction(undefined, retryItem.aiRequest)}>{t('retryAiSubmit')}</button>}
    </header>
    {selectedEdge && <label className="edge-label-editor">{t('relationLabel')}<input value={board.links.find(link => link.id === selectedEdge)?.label ?? ''} onChange={event => commit({ ...board, links: board.links.map(link => link.id === selectedEdge ? { ...link, label: event.target.value } : link) })} /></label>}
    <div ref={canvasRef} className="whiteboard-canvas" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }} onDrop={event => {
      event.preventDefault(); const path = event.dataTransfer.getData('application/x-kos-card'); const source = files.find(item => !item.deleted && item.path === path);
      if (source) add('card', source, screenToFlowPosition({ x: event.clientX, y: event.clientY }));
    }}>
      <ReactFlow<CanvasNode> nodes={nodes} edges={edges} nodeTypes={nodeTypes} elevateNodesOnSelect={false} fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.15} maxZoom={2.5}
        onNodesChange={changes => {
          setNodes(previous => {
            const next = applyNodeChanges(changes, previous);
            const positions = changes.flatMap(change => change.type === 'position' && change.position ? [{ id: change.id, ...change.position }] : []);
            if (!positions.length || !dragStart.current) return next;
            const moving = movePlacements(dragStart.current, positions);
            return next.map(node => { const item = moving.items.find(item => item.id === node.id); return item ? { ...node, position: { x: item.x, y: item.y } } : node; });
          });
          const value = current.current; if (!value) return;
          let next = value;
          for (const change of changes) {
            if (change.type === 'remove') next = { ...next, items: next.items.filter(item => item.id !== change.id), links: next.links.filter(link => link.from !== change.id && link.to !== change.id) };
            if (change.type === 'dimensions' && change.resizing === false && change.dimensions) next = { ...next, items: next.items.map(item => item.id === change.id ? { ...item, width: change.dimensions!.width, height: change.dimensions!.height } : item) };
          }
          if (next !== value) commit(next);
        }}
        onNodeDragStart={() => { dragStart.current = current.current; }}
        onNodeDragStop={(_, node, dragged) => { const moved = dragged.length ? dragged : [node]; const origin = dragStart.current ?? current.current!; dragStart.current = null; commit(movePlacements(origin, moved.map(value => ({ id: value.id, ...value.position })))); }}
        onEdgesChange={changes => { const removed = changes.filter(change => change.type === 'remove').map(change => change.id); if (removed.length) commit({ ...current.current!, links: current.current!.links.filter(link => !removed.includes(link.id)) }); }}
        onConnect={connection => { if (connection.source !== connection.target) commit({ ...current.current!, links: [...current.current!.links, { id: uniqueId(), from: connection.source, to: connection.target }] }); }}
        onEdgeClick={(_, edge) => setSelectedEdge(edge.id)} onPaneClick={() => setSelectedEdge(null)}
        onNodeDoubleClick={(_, node) => { if (node.data.file) open(node.data.file); }}>
        <Background gap={24} /><Controls showInteractive={false} />
      </ReactFlow>
      {!board.items.length && <div className="whiteboard-empty"><p>{t('boardEmpty')}</p><small>{t('connectingHint')}</small></div>}
    </div>
    <footer><small>{t('removeFromBoardHint')}</small><button onClick={() => { const ids = nodes.filter(node => node.selected).map(node => node.id); if (ids.length) commit({ ...board, items: board.items.filter(item => !ids.includes(item.id)), links: board.links.filter(link => !ids.includes(link.from) && !ids.includes(link.to)) }); }} disabled={!nodes.some(node => node.selected)}>{t('removeFromBoard')}</button><button onClick={() => void fitView()}>{t('all')}</button></footer>
  </section>;
}
