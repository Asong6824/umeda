import type { Placement, Whiteboard } from './model';

export function sectionContents(board: Whiteboard, section: Placement): Placement[] {
  return board.items.filter(item => item.id !== section.id && item.x >= section.x && item.y >= section.y
    && item.x + item.width <= section.x + section.width && item.y + (item.folded ? 72 : item.height) <= section.y + section.height);
}
/** Absolute coordinates stay portable. Membership follows what's inside at drag start. */
export function movePlacements(board: Whiteboard, positions: Array<{ id: string; x: number; y: number }>): Whiteboard {
  const explicit = new Map(positions.map(item => [item.id, item]));
  const groups = board.items.filter(item => item.kind === 'section' && explicit.has(item.id))
    .sort((a, b) => a.width * a.height - b.width * b.height)
    .map(section => ({ section, members: new Set(sectionContents(board, section).map(item => item.id)) }));
  return { ...board, items: board.items.map(item => {
    const own = explicit.get(item.id);
    if (own) return { ...item, x: own.x, y: own.y };
    const group = groups.find(group => group.members.has(item.id));
    if (!group) return item;
    const moved = explicit.get(group.section.id)!;
    return { ...item, x: item.x + moved.x - group.section.x, y: item.y + moved.y - group.section.y };
  }) };
}
export function selectedCards(board: Whiteboard, selected: string[]) {
  const ids = new Set(selected);
  for (const section of board.items.filter(item => item.kind === 'section' && ids.has(item.id)))
    for (const item of sectionContents(board, section)) ids.add(item.id);
  return board.items.filter(item => ids.has(item.id) && item.card);
}
