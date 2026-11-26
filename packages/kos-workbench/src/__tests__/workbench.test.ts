/**
 * Production: WorkbenchStore + CloudVault, YAML document edits and reading-state merge.
 * Gap: earlier relay tests cover bytes, not persisted human drafts or semantic note conflicts.
 * Rule: protocol compatibility and local storage; no accepted edit may disappear on reconnect.
 * Minimal inputs: one offline edit, competing edits, or deletion of one highlight. Tier: unit.
 */
import { describe, expect, it } from 'vitest';
import { fixture } from '../../scripts/fixture';
import type { WorkbenchHost } from '../host';
import { WorkbenchStore } from '../store';
import { patchMarkdown, parseMetadata, splitMarkdown, indexedObjects } from '../documents';
import { currentActionTasks } from '../core/dashboard';
import { mergeReadingStates, type ReadingState } from '../reader/state';
import { LibraryService, type WorkbenchSnapshot } from '../library/service';
import { LibraryClient } from '../library/client';
import { dispatchLibrary } from '../library/rpc';
import { readerIdentity, restoreReaderContext } from '../reader/identity';
import { resolveReference } from '../documents';
import { CardRepository } from '../cards/repository';
import { cardRef, cardsFromFiles, resolveCard, needsReview, parseWhiteboard } from '../cards/model';
import { movePlacements, selectedCards } from '../cards/geometry';
import { prepareCardAiAction, submitPluginCardAction } from '../cards/actions';
import { stampAgentCard } from '../cards/provenance';

describe('portable KOS workbench', () => {
  // Unit: section movement must move contained cards once, keep outside cards fixed,
  // and persist through the real board repository. Existing tests only move flat cards.
  it('moves a section with its contained cards and reopens the same grouped geometry', async () => {
    const data = fixture(); await data.initialize(); const store = new LibraryService(data.host); await store.initialize();
    const repository = new CardRepository(store, 'notes'), file = await repository.createBoard('Group');
    const board = { version: 1 as const, items: [
      { id: 'group', kind: 'section' as const, x: 0, y: 0, width: 600, height: 500 },
      { id: 'inside', kind: 'card' as const, x: 50, y: 80, width: 280, height: 240, card: { id: 'path:inside.md', path: 'inside.md' } },
      { id: 'outside', kind: 'card' as const, x: 900, y: 80, width: 280, height: 240, card: { id: 'path:outside.md', path: 'outside.md' } },
    ], links: [] };
    expect(selectedCards(board, ['group']).map(item => item.id)).toEqual(['inside']);
    const moved = movePlacements(board, [{ id: 'group', x: 100, y: 200 }]);
    await repository.saveBoard(file, moved);
    const saved = await repository.readBoard(store.files('notes').find(item => item.path === file.path)!);
    expect(saved.items.find(item => item.id === 'inside')).toMatchObject({ x: 150, y: 280 });
    expect(saved.items.find(item => item.id === 'outside')).toMatchObject({ x: 900, y: 80 });
    const explicitlyMoved = movePlacements(board, [{ id: 'group', x: 100, y: 200 }, { id: 'inside', x: 150, y: 280 }]);
    expect(explicitlyMoved.items.find(item => item.id === 'inside')).toMatchObject({ x: 150, y: 280 });
    store.dispose();
  });
  // Unit: a later AI draft must not replace the accepted snapshot or self-approve;
  // accept/keep operations must survive normal saves. Prior review tests only hash one body.
  it('keeps the accepted body while reviewing an AI revision and can keep or accept the revision', async () => {
    const data = fixture(); await data.initialize(); const store = new LibraryService(data.host); await store.initialize();
    const repository = new CardRepository(store, 'notes'), file = await repository.createNote('Accepted', 'Original accepted idea', { generated_by: 'ai' });
    const accepted = await repository.review(file, await repository.readCurrentText(file));
    const firstSnapshot = parseMetadata(splitMarkdown(accepted).frontmatter).kos_reviewed_body;
    const proposed = stampAgentCard(file.path, patchMarkdown(accepted, {}, 'Proposed new idea'), accepted);
    let current = store.files('notes').find(item => item.path === file.path)!;
    await store.saveText('notes', file.path, proposed, current.revision);
    expect(needsReview(proposed)).toBe(true);
    expect(splitMarkdown((await repository.reviewBase(proposed))!).body).toContain('Original accepted idea');
    current = store.files('notes').find(item => item.path === file.path)!;
    const kept = await repository.keepAccepted(current, proposed);
    expect(needsReview(kept)).toBe(false); expect(splitMarkdown(kept).body).toContain('Original accepted idea');
    current = store.files('notes').find(item => item.path === file.path)!;
    const next = await repository.review(current, proposed);
    expect(needsReview(next)).toBe(false);
    expect(splitMarkdown((await repository.reviewBase(next))!).body).toBe('Proposed new idea');
    expect(store.files('notes').some(item => item.path === firstSnapshot)).toBe(true);
    store.dispose();
  });
  // Unit: only selected notes leave the view; public task calls use stable keys and
  // inherit host execution settings. Oversized bodies become exact source references.
  it('prepares explicit card context and submits it through ordinary task APIs', async () => {
    const data = fixture(); await data.initialize(); const store = new LibraryService(data.host); await store.initialize();
    const repository = new CardRepository(store, 'notes'), chosen = await repository.createNote('Chosen', 'chosen-body'), other = await repository.createNote('Other', 'must-not-send');
    const board = { version: 1 as const, items: [chosen, other].map((file, index) => ({ id: `p${index}`, kind: 'card' as const, x: index * 400, y: 0, width: 280, height: 240, card: cardRef(file) })), links: [] };
    const prepared = await prepareCardAiAction(store, 'notes', board, ['p0'], 'summarize', 'stable-request', 'Summary');
    expect(prepared.request.prompt).toContain('chosen-body'); expect(prepared.request.prompt).not.toContain('must-not-send');
    expect(prepared.request.prompt).toContain(JSON.stringify(cardRef(chosen).id));
    const calls: unknown[] = [];
    const tasks = { capabilities: async () => ({ operations: ['create', 'send'] }), create: async (input: unknown) => { calls.push(input); return { taskId: 'task', revision: 4 }; }, send: async (input: unknown) => { calls.push(input); return { runId: 'run' }; } };
    expect(await submitPluginCardAction(tasks, prepared.request)).toMatchObject({ taskId: 'task', runId: 'run', disposition: 'submitted' });
    expect(calls[0]).toEqual({ requestKey: 'kos:stable-request:create', title: 'Summary' });
    expect(calls[1]).toMatchObject({ taskId: 'task', expectedRevision: 4, requestKey: 'kos:stable-request:send' });
    const latest = store.files('notes').find(item => item.path === chosen.path)!;
    await store.saveText('notes', latest.path, patchMarkdown(await repository.readCurrentText(latest), {}, 'long-body'.repeat(5000)), latest.revision);
    const referenced = await prepareCardAiAction(store, 'notes', board, ['p0'], 'compare', 'large-request', 'Compare');
    expect(referenced.request.prompt.length).toBeLessThanOrEqual(32768);
    expect(referenced.request.prompt).toContain('expected_hash'); expect(referenced.request.prompt).not.toContain('long-body');
    store.dispose();
  });
  // Unit: user's Card/Whiteboard contract. Existing queue tests don't cover shared
  // card identity, board placements, or content-bound review. Minimal: one card,
  // two boards, and an offline restart through the real LibraryService/CloudVault.
  it('reopens offline cards and boards and syncs shared references without copying their content', async () => {
    const data = fixture(); await data.initialize();
    const first = new LibraryService(data.host); await first.initialize(); data.setOffline(true);
    const repository = new CardRepository(first, 'notes');
    const card = await repository.createNote('同一想法', '共享正文');
    const boards = await Promise.all([repository.createBoard('学习'), repository.createBoard('创作')]);
    for (const board of boards) await repository.saveBoard(board, { version: 1, items: [{ id: 'placement', kind: 'card', card: cardRef(card), x: 10, y: 20, width: 280, height: 240 }], links: [] });
    first.dispose();
    const next = new LibraryService(data.host); await next.ready();
    const reopened = new CardRepository(next, 'notes');
    expect(cardsFromFiles(next.files('notes')).map(item => item.title)).toEqual(['同一想法']);
    for (const board of boards) {
      const saved = await reopened.readBoard(next.files('notes').find(item => item.path === board.path)!);
      expect(resolveCard(saved.items[0].card!, next.files('notes'))?.path).toBe(card.path);
      expect(JSON.stringify(saved)).not.toContain('共享正文');
    }
    data.setOffline(false); await next.refresh();
    expect(next.getSnapshot().pending).toEqual([]);
    // A second local replica downloads from the same synthetic cloud, no Mac mirror needed.
    const deviceLocal = new Map<string, unknown>();
    const device = new LibraryService({ async call<T>(operation: string, raw?: unknown) {
      const args = raw as { key: string; value: unknown };
      if (operation === 'get') return deviceLocal.get(args.key) as T;
      if (operation === 'set') { deviceLocal.set(args.key, args.value); return undefined as T; }
      if (operation === 'remove') { deviceLocal.delete(args.key); return undefined as T; }
      return data.host.call<T>(operation, raw);
    } });
    await device.initialize();
    const copiedBoard = await new CardRepository(device, 'notes').readBoard(device.files('notes').find(item => item.path === boards[0].path)!);
    const copiedCard = resolveCard(copiedBoard.items[0].card!, device.files('notes'))!;
    expect(await device.readText('notes', copiedCard)).toContain('共享正文');
    // Removing a placement never removes the original card or its other appearance.
    await reopened.saveBoard(next.files('notes').find(item => item.path === boards[0].path)!, { version: 1, items: [], links: [] });
    expect(cardsFromFiles(next.files('notes'))).toHaveLength(1);
    expect((await reopened.readBoard(next.files('notes').find(item => item.path === boards[1].path)!)).items).toHaveLength(1);
    device.dispose(); next.dispose();
  });
  it('keeps card references across moves and does not substitute reused paths', async () => {
    const data = fixture(); await data.initialize(); const store = new LibraryService(data.host); await store.initialize();
    const repository = new CardRepository(store, 'notes'), card = await repository.createNote('Identity', 'Original');
    await store.refresh(); const original = store.files('notes').find(file => file.path === card.path)!;
    const reference = cardRef(original);
    await store.move('notes', original.path, 'cards/renamed.md', original.revision); await store.refresh();
    expect(resolveCard(reference, store.files('notes'))?.path).toBe('cards/renamed.md');
    expect(resolveCard(reference, [{ ...original, frontmatter: 'type: card\ncard_id: replacement', documentId: 'replacement' }])).toBeUndefined();
    store.dispose();
  });
  it('reviews the exact AI body while keeping layout and tag changes outside review', async () => {
    const data = fixture(); await data.initialize(); const store = new LibraryService(data.host); await store.initialize();
    const repository = new CardRepository(store, 'notes');
    const card = await repository.createNote('AI thought', 'Unverified idea', { generated_by: 'ai' });
    const text = await store.readText('notes', card); expect(needsReview(text)).toBe(true);
    await repository.review(card, text);
    const reviewed = await store.readText('notes', store.files('notes').find(file => file.path === card.path)!);
    expect(needsReview(reviewed)).toBe(false);
    expect(needsReview(patchMarkdown(reviewed, { tags: ['another topic'] }))).toBe(false);
    expect(needsReview(patchMarkdown(reviewed, {}, 'Changed by AI'))).toBe(true);
    store.dispose();
  });
  it('preserves an unreadable future whiteboard instead of resetting it', async () => {
    const data = fixture(); await data.initialize(); await data.seed('whiteboards/future.md', patchMarkdown('', { type: 'whiteboard', title: 'Future' }, '{"version":2,"items":[],"links":[]}'));
    const store = new LibraryService(data.host); await store.initialize(); const file = store.files('notes')[0];
    const before = await store.readText('notes', file);
    await expect(new CardRepository(store, 'notes').saveBoard(file, { version: 1, items: [], links: [] })).rejects.toThrow('INVALID_WHITEBOARD');
    expect(await store.readText('notes', file)).toBe(before);
    expect(() => parseWhiteboard(patchMarkdown('', {}, '{"version":1,"items":[],"links":[{"id":"x","from":"missing","to":"missing"}]}'))).toThrow();
    store.dispose();
  });
  // Unit: real UI bridge timing regression found in whiteboard smoke. A save reply
  // can still carry revision zero after the host has already acknowledged the file.
  it('opens a new board when its acknowledgement overtakes the view snapshot', async () => {
    const data = fixture(); await data.initialize(); const service = new LibraryService(data.host); await service.initialize();
    const client = new LibraryClient({ async call<T>(operation: string, raw?: unknown) {
      expect(operation).toBe('library');
      const result = await dispatchLibrary(service, raw);
      if ((raw as { command: string }).command === 'saveText') await service.refresh();
      return result as T;
    } }, () => () => {});
    const repository = new CardRepository(client, 'notes');
    const board = await repository.createBoard('Immediately open');
    expect(board.revision).toBe(0);
    expect(await repository.readBoard(board)).toEqual({ version: 1, items: [], links: [] });
    client.dispose(); service.dispose();
  });
  // Unit/U06: incomplete extraction must not claim complete coverage; stale-version
  // text must never be searchable as the current book. Existing tests only index Markdown.
  it('reopens partial book indexes, exposes complete offline hits with locators, and excludes replaced books', async () => {
    const data=fixture();await data.initialize();await data.seed('book.pdf',new Uint8Array([1,2,3]));
    const initial=new LibraryService(data.host);await initial.initialize();const book=initial.files('notes')[0];
    await initial.indexBookPart('notes',book,0,{text:'第一部分 长期上下文',location:'page:1',label:'1'});
    expect((await initial.search('notes','上下文')).hits).toEqual([]);initial.dispose();
    const next=new LibraryService(data.host);await next.ready();
    expect(next.getSnapshot().bookIndexes?.[`notes:${book.hash}`].complete).toBe(false);
    await next.indexBookPart('notes',book,0,{text:'第一部分 长期上下文',location:'page:1',label:'1'});
    await next.indexBookPart('notes',book,1,{text:'第二部分 恢复能力',location:'page:2',label:'2'});
    await next.completeBookIndex('notes',book,2);data.setOffline(true);
    const result=await next.search('notes','恢复能力');
    expect(result.covered).toBe(1);expect(result.total).toBe(1);
    expect(result.hits[0]).toMatchObject({location:'page:2',label:'2',snippet:'第二部分 恢复能力'});
    data.setOffline(false);await data.seed('book.pdf',new Uint8Array([4,5,6]),book.revision);await next.refresh();
    expect((await next.search('notes','恢复能力')).hits).toEqual([]);
    await expect(next.indexBookPart('notes',book,2,{text:'late',location:'page:3',label:'3'})).rejects.toMatchObject({status:409});
    next.dispose();
  });
  // Unit/U04: queued renames survive process recreation and keep edits addressed to
  // their original identity until the CAS receipt. Existing move test required a network.
  it('replays a durable offline rename after edits and preserves identity and cached reads', async () => {
    const data = fixture(); await data.initialize(); await data.seed('before.md', '# original');
    const first = new LibraryService(data.host); await first.initialize();
    const original = first.files('notes')[0]; await first.readText('notes', original);
    data.setOffline(true);
    await first.saveText('notes', original.path, '# before rename', original.revision); await first.refresh();
    await first.move('notes', original.path, 'folder/after.md', original.revision); await first.refresh();
    expect(first.files('notes').map(file => file.path)).toEqual(['folder/after.md']);
    await first.saveText('notes', 'folder/after.md', '# after rename', original.revision); await first.refresh();
    first.dispose();
    const next = new LibraryService(data.host); await next.ready();
    expect(next.getSnapshot().moves).toHaveLength(1);
    expect(await next.readText('notes', next.files('notes')[0])).toBe('# after rename');
    expect((await next.search('notes', 'after rename')).hits[0].file.path).toBe('folder/after.md');
    data.setOffline(false); await next.refresh();
    expect(next.getSnapshot().moves).toEqual([]); expect(next.getSnapshot().pending).toEqual([]);
    expect(next.files('notes')[0].documentId).toBe(original.documentId);
    expect(next.files('notes')[0].path).toBe('folder/after.md');
    expect(await next.readText('notes', next.files('notes')[0])).toBe('# after rename'); next.dispose();
  });
  // Unit/U04: a committed move with a lost receipt is ambiguous. Retry must recognize
  // identity/alias and leave a different document subsequently created at the old path.
  it('recovers a lost move receipt without hiding or moving a reused source path', async () => {
    const data = fixture(); await data.initialize(); await data.seed('before.md', '# original');
    let lose = true;
    const port: WorkbenchHost = { async call<T>(operation: string, raw?: unknown) {
      const result = await data.host.call<T>(operation, raw);
      if (lose && operation === 'http' && (raw as {path:string}).path.endsWith('/move')) {
        lose = false; const tombstone = JSON.parse((await data.callHttp('/api/vaults/notes/stat?path=before.md')).body);
        await data.seed('before.md', '# unrelated new document', tombstone.revision); data.setOffline(true);
        throw new Error('lost response');
      }
      return result;
    } };
    const first = new LibraryService(port); await first.initialize(); const original = first.files('notes')[0];
    await first.move('notes', 'before.md', 'after.md', original.revision); await first.refresh();
    expect(first.getSnapshot().moves).toHaveLength(1);
    await expect(first.saveText('notes','after.md','# ambiguous',original.revision)).rejects.toMatchObject({status:423});
    first.dispose();
    data.setOffline(false); const next = new LibraryService(port); await next.initialize();
    expect(next.getSnapshot().moves).toEqual([]);
    expect(next.files('notes').map(file => file.path).sort()).toEqual(['after.md','before.md']);
    expect(await next.readText('notes', next.files('notes').find(file => file.path === 'before.md')!)).toBe('# unrelated new document');
    expect(next.files('notes').find(file => file.path === 'after.md')!.documentId).toBe(original.documentId); next.dispose();
  });
  // Unit/U04: an occupied destination must remain untouched and the operation retained
  // for an explicit cancel/retry, rather than a generic failed request or overwrite.
  it('retains a conflicting offline move and allows explicit retry after the target is free', async () => {
    const data = fixture(); await data.initialize(); await data.seed('before.md', '# original');
    const store = new LibraryService(data.host); await store.initialize(); const original = store.files('notes')[0];
    data.setOffline(true); await store.move('notes','before.md','after.md',original.revision); await store.refresh();
    const target = await data.seed('after.md','# other') as {revision:number};
    data.setOffline(false); await store.refresh();
    expect(store.getSnapshot().moves?.[0].status).toBe('conflict');
    expect(store.files('notes')).toHaveLength(2);
    await data.callHttp('/api/vaults/notes/file?path=after.md','DELETE',undefined,{'x-vault-base-revision':String(target.revision)});
    await store.retryMove('notes',store.getSnapshot().moves![0].id);
    expect(store.getSnapshot().moves).toEqual([]);
    expect(store.files('notes').map(file => file.path)).toEqual(['after.md']); store.dispose();
  });

  // Unit/U09: a bridge may piggyback the same snapshot on a query reply. Publishing it
  // again can restart a view's query effect forever; older tests only rejected stale sequences.
  it('does not republish an identical host snapshot when a query response repeats it', async () => {
    const data=fixture();await data.initialize();
    const service=new LibraryService(data.host);await service.initialize();
    let receive!: (value:WorkbenchSnapshot)=>void;
    const client=new LibraryClient({call:async()=>service.getSnapshot() as any}, listener=>{receive=listener;return()=>{};});
    let notices=0;client.subscribe(()=>notices++);
    await client.ready();const before=notices;
    receive(structuredClone(service.getSnapshot()));
    expect(notices).toBe(before);client.dispose();service.dispose();
  });
  // Unit/U06: search must match text past the summary, include pending local edits and
  // make zero network calls. Previous tests only covered frontmatter/reader-local queries.
  it('pins text for offline full-body search and sees unsynced edits without a request', async () => {
    const data = fixture(); await data.initialize();
    await data.seed('long.md', '# Title\n' + 'padding '.repeat(250) + '\n中文查询必须找到这里。');
    const store = new LibraryService(data.host); await store.initialize();
    expect((await store.search('notes', '中文')).covered).toBe(0);
    await store.pinOffline('notes'); await store.syncOffline();
    expect(store.getSnapshot().downloads?.[0].status).toBe('ready');
    data.setOffline(true);
    const result = await store.search('notes', '中文');
    expect(result.hits.map(hit => hit.file.path)).toEqual(['long.md']);
    expect(result.hits[0].snippet).toContain('中文查询');
    expect(result.covered).toBe(1);
    await store.saveText('notes','long.md','# title\n本机未同步的内容',store.files('notes')[0].revision);
    expect((await store.search('notes','未同步')).hits).toHaveLength(1);
    expect((await store.search('notes','中文')).hits).toHaveLength(0);
    store.dispose();
  });
  // Unit/U07: a cancelled/terminated download retains completed chunks; its late reply
  // cannot mark the cancelled job complete. Minimal input crosses one 256 KiB boundary.
  it('resumes an interrupted offline attachment from persisted chunks after service recreation', async () => {
    const data = fixture(); await data.initialize();
    await data.seed('book.pdf',new Uint8Array(600 * 1024).fill(31));
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), second = new Promise<void>(resolve => { reached = resolve; });
    const requests: number[] = [];
    let pause = true;
    const host: WorkbenchHost = { async call<T>(op: string, raw?: unknown): Promise<T> {
      const p = raw as {path?:string};
      if(op==='http' && p.path?.includes('encoding=base64')) {
        const offset=Number(new URL('https://fixture.invalid'+p.path).searchParams.get('offset'));requests.push(offset);
        if(pause && offset===256*1024){reached();await gate;}
      }
      return data.host.call(op,raw);
    } };
    const initial=new LibraryService(host);await initial.initialize();await initial.pinOffline('notes','book.pdf');await second;
    await initial.cancelOffline('notes','book.pdf');initial.dispose();release();await initial.syncOffline();
    requests.length=0;pause=false;
    const next=new LibraryService(host);await next.initialize();await next.pinOffline('notes','book.pdf');await next.syncOffline();
    expect(requests).toEqual([256*1024,512*1024]);
    expect(next.getSnapshot().downloads?.[0].status).toBe('ready');
    next.dispose();
  });
  // Unit / U05: a stalled remote refresh must not delay cached reads or durable local edits.
  // Offline-immediate-failure tests do not exercise an HTTP request that remains in flight.
  it('opens cached content and saves locally while startup refresh is still in flight', async () => {
    const data = fixture(); await data.initialize(); await data.seed('note.md', '# cached');
    const initial = new WorkbenchStore(data.host); await initial.initialize();
    const file = initial.files('notes')[0]; await initial.readText('notes', file); initial.dispose();
    let release!: () => void, entered!: () => void, hold = true;
    const gate = new Promise<void>(resolve => { release = resolve; }), observed = new Promise<void>(resolve => { entered = resolve; });
    const port: WorkbenchHost = { async call<T>(operation: string, payload?: unknown): Promise<T> {
      if (hold && operation === 'http') { hold = false; entered(); await gate; }
      return data.host.call<T>(operation, payload);
    } };
    const service = new LibraryService(port), startup = service.initialize();
    await observed; await service.ready();
    expect(await service.readText('notes', file)).toBe('# cached');
    await service.saveText('notes', file.path, '# new local edit', file.revision);
    expect(service.getSnapshot().pending).toHaveLength(1);
    release(); await startup;
    expect(await service.readText('notes', service.files('notes')[0])).toBe('# new local edit');
    service.dispose();
  });
  // Unit / U03,U04: real service commands preserve legacy notes/drafts after a move,
  // and expose deleted documents for CAS restore. Earlier conflicts tests never rename a file.
  it('keeps reading context across moves and restores a deleted document through its history', async () => {
    const data = fixture(); await data.initialize(); await data.seed('old.md', '# first');
    const store = new WorkbenchStore(data.host); await store.initialize(); const first = store.files('notes')[0];
    const oldFile = { ...first, documentId: undefined };
    const legacy = readerIdentity('notes', oldFile);
    const record: ReadingState = { version: 1, path: first.path, documentHash: first.hash, progress: { kind: 'markdown', location: 'scroll:100', progress: null, updatedAt: '2026-11-21T00:00:00Z' }, annotations: [], deleted: {} };
    await store.savePreference(legacy.draftKey, { text: '# unsaved', baseRevision: first.revision });
    await store.savePreference(legacy.recordKey, record);
    await store.move('notes', first.path, 'folder/moved.md', first.revision);
    await store.refresh();
    const moved = store.files('notes')[0];
    expect(moved.documentId).toBe(first.documentId);
    expect(resolveReference('old.md', 'index.md', store.files('notes'))?.path).toBe('folder/moved.md');
    const restored = await restoreReaderContext(store, 'notes', moved, store.files('notes'));
    expect(restored.draft?.text).toBe('# unsaved'); expect(restored.record?.progress?.location).toBe('scroll:100');
    await store.savePreference(readerIdentity('notes', moved).draftKey, null);
    expect((await restoreReaderContext(store, 'notes', moved, store.files('notes'))).draft).toBeNull();
    const removed = await data.callHttp(`/api/vaults/notes/file?path=folder%2Fmoved.md`, 'DELETE', undefined, { 'x-vault-base-revision': String(moved.revision) });
    const tombstone = JSON.parse(removed.body); await store.refresh();
    expect(store.getSnapshot().catalog.trash?.notes.map(file => file.path)).toEqual(['folder/moved.md']);
    expect(await store.readVersion('notes', (await store.history('notes', moved.path)).files.find(version => !version.deleted)!)).toBe('# first');
    await store.restore('notes', moved.path, first.revision, tombstone.revision);
    expect(store.getSnapshot().catalog.trash?.notes).toEqual([]);
    expect(await store.readText('notes', store.files('notes')[0])).toBe('# first');
    expect(await store.preference(legacy.recordKey, null)).toEqual(record);
    store.dispose();
  });
  // Unit / U02,U03: a view is disposable, its host queue is not. The old recreation case
  // cannot prove delivery after a client closes, or atomic receipt failure behavior.
  it('delivers after its view closes and retains the durable queue when a receipt transaction fails', async () => {
    const data = fixture(); await data.initialize(); await data.seed('note.md', '# base');
    let fail = false;
    const port: WorkbenchHost = { async call<T>(operation: string, raw?: unknown): Promise<T> {
      if (operation === 'info') return { namespace: 'fixture', atomic: true } as T;
      if (operation === 'commit') {
        if (fail) throw new Error('full disk');
        for (const entry of (raw as { entries: Array<{ key: string; value: string }> }).entries) data.local.set(entry.key, entry.value);
        return undefined as T;
      }
      return data.host.call<T>(operation, raw);
    } };
    const service = new LibraryService(port); await service.initialize();
    const listeners = new Set<(value: WorkbenchSnapshot) => void>();
    const stop = service.subscribe(() => { for (const listener of listeners) listener(service.getSnapshot()); });
    const proxy: WorkbenchHost = { async call<T>(_operation: string, payload?: unknown) { return await dispatchLibrary(service, payload) as T; } };
    const attach = (listener: (value: WorkbenchSnapshot) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
    const view = new LibraryClient(proxy, attach); await view.ready(); const file = view.files('notes')[0];
    data.setOffline(true); await view.saveText('notes', file.path, '# offline', file.revision); await service.refresh();
    view.dispose(); expect(listeners.size).toBe(0);
    data.setOffline(false); fail = true; await service.refresh();
    expect(service.getSnapshot().pending).toHaveLength(1);
    const recovery = new LibraryService(port); await recovery.ready();
    expect(recovery.getSnapshot().pending[0].text).toBe('# offline'); recovery.dispose();
    fail = false; await service.refresh();
    expect(service.getSnapshot().pending).toHaveLength(0);
    const reopened = new LibraryClient(proxy, attach); await reopened.ready(); data.setOffline(true);
    expect(await reopened.readText('notes', reopened.files('notes')[0])).toBe('# offline');
    reopened.dispose(); stop(); service.dispose();
  });
  // Unit / U03,U05: delayed scope discovery must not put preferences in an unscoped key,
  // nor let an early save replace the durable queue. Existing recreation tests initialize first.
  it('waits for local recovery before early edits without waiting for the network', async () => {
    const data = fixture(); await data.initialize();
    const old = new WorkbenchStore(data.host); await old.initialize(); data.setOffline(true);
    await old.saveText('notes', 'old.md', '# recovered', 0); await old.refresh(); old.dispose();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const host: WorkbenchHost = { async call<T>(operation: string, payload?: unknown): Promise<T> {
      if (operation === 'info') await gate;
      return data.host.call<T>(operation, payload);
    } };
    const store = new WorkbenchStore(host);
    const preference = store.savePreference('layout', { columns: 2 });
    const edit = store.saveText('notes', 'new.md', '# new', 0);
    release(); await Promise.all([preference, edit]); await store.refresh();
    expect(store.getSnapshot().pending.map(item => item.path)).toEqual(['old.md', 'new.md']);
    expect(data.local.has('preference:layout')).toBe(false);
    expect(await store.preference('layout', null)).toEqual({ columns: 2 });
    const reopened = new WorkbenchStore(data.host); await reopened.initialize();
    expect(reopened.getSnapshot().pending.map(item => item.path)).toEqual(['old.md', 'new.md']);
    store.dispose(); reopened.dispose();
  });
  it('patches explicit fields while preserving unknown attributes, comments, body and object links', () => {
    const original = '---\ntype: task\n# retain this rationale\nstatus: todo\ncustom: {owner: me}\nprojects:\n  - "[[31_项目/同步]]"\n---\n\n# Action\n\nOriginal body';
    const changed = patchMarkdown(original, { status: 'done', completed: '2026-11-20' });
    expect(changed).toContain('# retain this rationale');
    expect(splitMarkdown(changed).body).toBe(splitMarkdown(original).body);
    expect(parseMetadata(splitMarkdown(changed).frontmatter)).toMatchObject({ custom: { owner: 'me' }, projects: ['[[31_项目/同步]]'], status: 'done', completed: '2026-11-20' });
    expect(parseMetadata(splitMarkdown(patchMarkdown('', { type: 'task', title: 'New' }, '# New')).frontmatter).title).toBe('New');
    expect(() => patchMarkdown('---\nstatus: [\n---\nkeep', { status: 'done' })).toThrow();
  });
  it('retains offline edits across store recreation and drains them after reconnecting', async () => {
    const data = fixture(); await data.initialize();
    await data.seed('note.md', '# Original');
    const first = new WorkbenchStore(data.host); await first.initialize();
    const file = first.files('notes')[0];
    expect(await first.readText('notes', file)).toBe('# Original');
    data.setOffline(true);
    await first.saveText('notes', file.path, '# Offline edit', file.revision); await first.refresh(); first.dispose();
    const restored = new WorkbenchStore(data.host); await restored.initialize();
    expect(restored.getSnapshot().pending).toHaveLength(1);
    expect(await restored.readText('notes', restored.files('notes')[0])).toBe('# Offline edit');
    data.setOffline(false); await restored.refresh();
    expect(restored.getSnapshot().pending).toHaveLength(0);
    expect(await restored.readText('notes', restored.files('notes')[0])).toBe('# Offline edit');
    data.local.set('fixture:pending', '{broken draft');
    await expect(new WorkbenchStore(data.host).initialize()).rejects.toThrow('本机草稿格式有误');
    expect(data.local.get('fixture:pending')).toBe('{broken draft');

  });
  it('preserves the original and creates a readable conflict copy for a stale offline edit', async () => {
    const data = fixture(); await data.initialize(); await data.seed('note.md', '# Base');
    const store = new WorkbenchStore(data.host); await store.initialize(); const file = store.files('notes')[0];
    data.setOffline(true); await store.saveText('notes', file.path, '# Phone edit', file.revision); await store.refresh();
    await data.seed('note.md', '# Mac edit', file.revision);
    data.setOffline(false); await store.refresh();
    const files = store.files('notes'), conflict = files.find(file => file.path.includes('.sync-conflict-'))!;
    expect(await store.readText('notes', files.find(file => file.path === 'note.md')!)).toBe('# Mac edit');
    expect(await store.readText('notes', conflict)).toBe('# Phone edit');
    expect(store.getSnapshot().pending).toHaveLength(0);
  });
  it('shows explicitly scheduled actions today and reads multi-range attachments from cache offline', async () => {
    const data = fixture(); await data.initialize();
    await data.seed('action.md', patchMarkdown('', { type: 'task', title: 'Scheduled', status: 'todo', priority: 'P2', scheduled_for: '2026-11-20', created: '2026-11-20', projects: [] }, '# Scheduled'));
    await data.seed('done.md', patchMarkdown('', { type: 'task', title: 'Finished', status: 'done', priority: 'P2', scheduled_for: '2026-11-20', projects: [] }, '# Finished'));
    const binary = Uint8Array.from({ length: 530_003 }, (_, i) => i % 251); await data.seed('book.pdf', binary);
    const store = new WorkbenchStore(data.host); await store.initialize();
    expect(currentActionTasks(indexedObjects(store.files('notes')).objects, '2026-11-20').map(task => task.title)).toEqual(['Scheduled']);
    const book = store.files('notes').find(file => file.path === 'book.pdf')!;
    expect(await store.readBytes('notes', book)).toEqual(binary);
    data.setOffline(true); expect(await store.readBytes('notes', book)).toEqual(binary);
    data.setOffline(false);
    let open = true, ranges = 0;
    const cancelHost: WorkbenchHost = { async call<T>(operation: string, payload?: unknown): Promise<T> {
      if (operation === 'info') return { namespace: 'cancelled-reader' } as T;
      const result = await data.host.call<T>(operation, payload);
      if (operation === 'http' && (payload as { path: string }).path.includes('encoding=base64')) { ranges++; open = false; }
      return result;
    } };
    const cancelled = new WorkbenchStore(cancelHost); await cancelled.initialize();
    await expect(cancelled.readBytes('notes', book, () => open)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ranges).toBe(1);

  });
  it('merges concurrent reading records through the production save queue', async () => {
    const data = fixture(); await data.initialize();
    const path = '90_系统/umeda/reading/book.json';
    const base: ReadingState = { version: 1, path: 'book.md', documentHash: null, annotations: [], deleted: {} };
    const initial = await data.seed(path, JSON.stringify(base)) as { revision: number };
    const store = new WorkbenchStore(data.host); await store.initialize();
    const local = { ...base, progress: { kind: 'markdown', location: 'scroll:100', progress: null, updatedAt: '2026-11-20T10:00:00Z' } };
    const remote = { ...base, deleted: { obsolete: '2026-11-20T09:00:00Z' } };
    data.setOffline(true); await store.saveText('notes', path, JSON.stringify(local), initial.revision); await store.refresh();
    await data.seed(path, JSON.stringify(remote), initial.revision); data.setOffline(false); await store.refresh();
    expect(store.getSnapshot().pending).toHaveLength(0); expect(store.getSnapshot().conflicts).toHaveLength(0);
    const saved = JSON.parse(await store.readText('notes', store.files('notes').find(file => file.path === path)!));
    expect(saved).toMatchObject({ progress: local.progress, deleted: remote.deleted });
    const current = store.files('notes').find(file => file.path === path)!;
    await data.seed(path, '{"version":2,"future":"preserve"}', current.revision); await store.refresh();
    await store.saveText('notes', path, JSON.stringify(local), store.files('notes').find(file => file.path === path)!.revision); await store.refresh();
    expect(await store.readText('notes', store.files('notes').find(file => file.path === path)!)).toBe('{"version":2,"future":"preserve"}');
    expect(store.getSnapshot().conflicts).toHaveLength(1);

  });
  // Unit: a no-change check used to serialize/rewrite the entire catalog; first load needed 40-row pages.
  it('loads a small catalog in one bounded request and does no cache writes or catalog replacement on an empty delta', async () => {
    const data = fixture(); await data.initialize(); for (let n = 0; n < 45; n++) await data.seed(`note-${n}.md`, '# note');
    let indexes = 0, writes = 0;
    const host: WorkbenchHost = { async call<T>(operation: string, payload?: unknown): Promise<T> {
      if (operation === 'set') writes++;
      if (operation === 'http' && (payload as { path: string }).path.includes('/index?')) indexes++;
      return data.host.call<T>(operation, payload);
    } };
    const store = new WorkbenchStore(host); await store.initialize(); expect(store.files('notes')).toHaveLength(45); expect(indexes).toBe(1);
    const catalog = store.getSnapshot().catalog, before = writes; await store.refresh();
    expect(writes).toBe(before); expect(store.getSnapshot().catalog).toBe(catalog);
  });
  // Unit: a hint arriving after a response snapshot must cause a trailing read rather than be dropped.
  it('rechecks a late change hint during an in-flight refresh', async () => {
    const data = fixture(); await data.initialize(); await data.seed('first.md', '# first');
    let inject = false, store: WorkbenchStore;
    const host: WorkbenchHost = { async call<T>(operation: string, payload?: unknown): Promise<T> {
      const result = await data.host.call<T>(operation, payload);
      if (inject && operation === 'http' && (payload as { path: string }).path.includes('/index?')) {
        inject = false; await data.seed('late.md', '# late'); void store.refresh(true);
      }
      return result;
    } };
    store = new WorkbenchStore(host); await store.initialize(); inject = true; await store.refresh();
    expect(store.files('notes').map(file => file.path).sort()).toEqual(['first.md', 'late.md']);
  });
  // Unit: a server hint should refresh the foreground view before its minute timer, without leaving another watch behind.
  it('refreshes on a cloud revision hint and stops the live subscription on close', async () => {
    const data = fixture(); await data.initialize(); await data.seed('first.md', '# first');
    let enter!: () => void, watches = 0; const started = new Promise<void>(resolve => { enter = resolve; });
    const host: WorkbenchHost = { async call<T>(operation: string, payload?: unknown): Promise<T> {
      if (operation === 'http' && (payload as { path: string }).path.includes('/watch?')) { watches++; enter(); }
      return data.host.call<T>(operation, payload);
    } };
    const store = new WorkbenchStore(host); await store.initialize(); let stop = () => {};
    const updated = new Promise<void>(resolve => { const off = store.subscribe(() => { if (store.files('notes').some(file => file.path === 'late.md')) { stop(); off(); resolve(); } }); });
    stop = store.watch('notes'); await started; await data.seed('late.md', '# late'); await updated;
    expect(watches).toBe(1); store.dispose();
  });
  // Unit: upload acknowledgement and index download may be split by a network outage.
  it('persists accepted bytes and their metadata before clearing the local edit queue', async () => {
    const data = fixture(); await data.initialize(); await data.seed('note.md', '# old');
    let cut = false;
    const host: WorkbenchHost = { async call<T>(operation: string, payload?: unknown): Promise<T> {
      const result = await data.host.call<T>(operation, payload);
      if (cut && operation === 'http' && (payload as { method?: string }).method === 'PUT') data.setOffline(true);
      return result;
    } };
    const first = new WorkbenchStore(host); await first.initialize(); const file = first.files('notes')[0];
    cut = true; await first.saveText('notes', file.path, '# latest accepted', file.revision); await first.refresh(); first.dispose();
    const restored = new WorkbenchStore(host); await restored.initialize(); expect(restored.getSnapshot().pending).toHaveLength(0);
    expect(await restored.readText('notes', restored.files('notes')[0])).toBe('# latest accepted');
  });
  it('merges annotations by stable ID and keeps a deleted note deleted', () => {
    const annotation = (id: string, updatedAt: string) => ({ id, updatedAt, createdAt: updatedAt, text: id, note: '', sourcePath: 'book.md', documentPath: 'book.md', extractPath: 'marks.json', kind: 'markdown' as const, location: '', positionLabel: '', color: 'yellow' as const, anchor: { format: 'markdown' as const, quote: id } });
    const base: ReadingState = { version: 1, path: 'book.md', documentHash: null, annotations: [annotation('deleted', '2026-11-19')], deleted: {} };
    const local = { ...base, annotations: [annotation('phone', '2026-11-20'), ...base.annotations] };
    const remote = { ...base, annotations: [annotation('mac', '2026-11-20')], deleted: { deleted: '2026-11-20' } };
    const merged = JSON.parse(mergeReadingStates(JSON.stringify(local), JSON.stringify(remote))!);
    expect(merged.annotations.map((item: { id: string }) => item.id).sort()).toEqual(['mac', 'phone']);
    expect(merged.deleted.deleted).toBe('2026-11-20');
    expect(mergeReadingStates(JSON.stringify(local), '{"version":2}')).toBeNull();
  });
});
