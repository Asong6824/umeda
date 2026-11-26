// @vitest-environment jsdom
import { createElement } from 'react';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkItem, WorkManagementRequest, WorkManagementResponse, WorkOwnerStamp } from '@cindy/maker-shared/work-management';
import { WORK_MANAGEMENT_AVAILABLE, WORK_MANAGEMENT_CHANNEL } from '@cindy/maker-shared/work-management';

const bridge = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => unknown>(), listeners: new Set<(owner: WorkOwnerStamp) => void>(), dropAck: false }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => bridge.handlers.set(name, fn) }, BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_channel: string, owner: WorkOwnerStamp) => { for (const fn of bridge.listeners) fn(owner); } } }] } }));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => 'fixture-owner', isAppSessionBoundaryPending: () => false, getActiveDataOwnerPushStamp: () => ({ dataOwnerId: 'fixture-owner', ownerGeneration: 1 }) }));
vi.mock('../../device-link/selfHostedRelayRouting', () => ({ activeSelfHostedRelay: () => ({ authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'fixture' }) }));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: () => {}, isTrustedAppRendererWindow: () => true }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }), maskPath: (value: string) => value }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ dataOwnerId: 'fixture-owner', dataOwnerGeneration: 1 }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn() } }));

import { runWorkStore } from '@cindy/maker-shared/work-store';
import type { WorkEnvelope, WorkFeed } from '@cindy/maker-shared/work-replication';
import * as schema from '../schema';
import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import { createDbClientForHandle } from '../client/createDbClientForHandle';
import { clearCurrentDbClient, setCurrentDbClient } from '../client/current';
import type { DbClient } from '../client/DbClient';
import { registerWorkManagementIpc } from '../../work-management/ipc';
import { executeWorkManagement } from '../../work-management/host';
import { WorkPage } from '@/features/work-management/WorkPage';
import en from '@/i18n/locales/en/common.json';

// Value: real WorkPage -> registered IPC -> shared service -> production SQLite
// transaction -> view invalidation, plus Agent -> same records. Separate unit
// fixtures cannot prove durable parity or lost-ack dedup through the full chain.
// Minimum failures: Agent updates while an editor holds an old revision; a UI
// create commits then loses its receipt. Tier: db, isolated real SQLite + DOM;
// window metadata/relay route are isolated, no model/network or user profile.
// Standalone duration: 3.67s locally (2026-11-22).
describe('work UI and Agent share durable facts', () => {
  const owner = { dataOwnerId: 'fixture-owner', ownerGeneration: 1 };
  const context = { sessionId: 'agent-fixture', agentKind: 'codex' as const, workingDir: '/fixture' };
  const i18n = createInstance();
  void i18n.init({ lng: 'en', resources: { en: { common: en } }, defaultNS: 'common', initAsync: false });
  let db: Database.Database, client: DbClient, directory: string;
  const execute = async (request: WorkManagementRequest, stamp = owner): Promise<WorkManagementResponse> => {
    const result = await bridge.handlers.get(WORK_MANAGEMENT_CHANNEL)!({}, request, stamp) as WorkManagementResponse;
    if (bridge.dropAck && request.operation === 'create') { bridge.dropAck = false; throw new Error('lost acknowledgement after commit'); }
    return result;
  };
  beforeEach(() => {
    bridge.handlers.clear(); bridge.listeners.clear(); bridge.dropAck = false;
    directory = mkdtempSync(path.join(tmpdir(), 'umeda-ui-db-'));
    db = createBetterSqliteDatabase(path.join(directory, 'work.db')); db.pragma('foreign_keys=ON');
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT,cleared_at INTEGER);INSERT INTO sessions VALUES('agent-fixture','active',NULL)");
    db.exec(readFileSync(path.resolve('drizzle/0149_umeda_work_management.sql'), 'utf8'));
    db.exec(readFileSync(path.resolve('drizzle/0150_exotic_valeria_richards.sql'), 'utf8'));
    db.exec(readFileSync(path.resolve('drizzle/0151_vengeful_bulldozer.sql'), 'utf8'));
    client = createDbClientForHandle({ db, drizzle: drizzle(db, { schema }), dispose: async () => { db.close(); } });
    setCurrentDbClient(client, 'fixture-owner'); registerWorkManagementIpc();
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { workManagement: {
      syncStatus: async (stamp: WorkOwnerStamp) => bridge.handlers.get('umeda-work:sync-status')!({}, stamp),
      syncConflict: async (id: string, stamp: WorkOwnerStamp) => bridge.handlers.get('umeda-work:sync-conflict')!({}, id, stamp),
      resolveSync: async (id: string, choice: 'local' | 'remote', stamp: WorkOwnerStamp) => bridge.handlers.get('umeda-work:sync-resolve')!({}, id, choice, stamp),
      available: async (stamp: WorkOwnerStamp) => bridge.handlers.get(WORK_MANAGEMENT_AVAILABLE)!({}, stamp), execute,
      onChanged: (fn: (stamp: WorkOwnerStamp) => void) => { bridge.listeners.add(fn); return () => { bridge.listeners.delete(fn); }; },
    } } });
  });
  afterEach(async () => { cleanup(); clearCurrentDbClient(client); if (client) await client.dispose(); else db?.close(); rmSync(directory, { recursive: true, force: true }); });
  const mount = () => render(createElement(I18nextProvider, { i18n }, createElement(WorkPage)));
  const get = (id: string) => JSON.parse((db.prepare('SELECT data FROM umeda_work_items WHERE id=?').get(id) as { data: string }).data) as WorkItem;
  const createViaUi = async (kind: 'goal' | 'project' | 'task', title: string, relation?: string) => {
    fireEvent.click(screen.getByRole('radio', { name: kind === 'goal' ? 'Goals' : kind === 'project' ? 'Projects' : 'To-dos' }));
    fireEvent.click(screen.getByRole('button', { name: `New ${kind === 'task' ? 'to-do' : kind}` }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: title } });
    if (relation) { fireEvent.click(within(dialog).getByText('Link a project or goal (optional)')); fireEvent.click(await within(dialog).findByLabelText(relation)); }
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await screen.findByRole('heading', { name: title });
    return (db.prepare('SELECT id FROM umeda_work_items WHERE title=?').get(title) as { id: string }).id;
  };

  it('creates linked objects in the UI and shows Agent-completed work in project and goal records', async () => {
    mount(); await screen.findByRole('radio', { name: 'To-dos' });
    const goal = await createViaUi('goal', 'Learn systems');
    const project = await createViaUi('project', 'Reader', 'Learn systems');
    const task = await createViaUi('task', 'Read a chapter', 'Reader');
    await act(async () => { await executeWorkManagement(context, { operation: 'update', request_id: 'agent-delivery', summary: 'Reader milestone delivered', changes: [
      { id: task, expected_revision: 1, status: 'done' }, { id: goal, expected_revision: 1, progress: { percent: 40, basis: 'First milestone delivered; later chapters remain' } },
    ] }); });
    expect(get(task).status).toBe('done');
    fireEvent.click(screen.getByRole('radio', { name: 'Projects' }));
    fireEvent.click(await screen.findByRole('button', { name: /Reader.*In progress/ }));
    const detail = screen.getByRole('complementary');
    expect(await within(detail).findByText('Reader milestone delivered')).toBeTruthy();
    expect((await within(detail).findByRole('checkbox', { name: 'Reopen Read a chapter' })).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Goals' }));
    fireEvent.click(await screen.findByRole('button', { name: /Learn systems.*In progress/ }));
    expect(await screen.findByText('First milestone delivered; later chapters remain')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('40');
    expect(get(project).goal_ids).toEqual([goal]);
    expect(get(task).project_ids).toEqual([project]);
    expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual({ n: 1 });
    expect(db.pragma('quick_check', { simple: true })).toBe('ok');
  });

  it('keeps the draft and the actual Agent progress when saving a stale editor', async () => {
    const created = await execute({ operation: 'create', request_id: 'goal-create', kind: 'goal', title: 'Learn systems' });
    const goal = created.items![0].id;
    mount(); await screen.findByRole('radio', { name: 'To-dos' });
    fireEvent.click(screen.getByRole('radio', { name: 'Goals' }));
    fireEvent.click(await screen.findByRole('button', { name: /Learn systems.*In progress/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Progress (%)'), { target: { value: '20' } });
    fireEvent.change(within(dialog).getByLabelText('Progress note (optional)'), { target: { value: 'My draft' } });
    await act(async () => { await executeWorkManagement(context, { operation: 'update', request_id: 'agent-newer', summary: 'Verified milestone', changes: [{ id: goal, expected_revision: 1, progress: { percent: 60, basis: 'Other completed milestones' } }] }); });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await within(dialog).findByRole('alert');
    expect((within(dialog).getByLabelText('Progress (%)') as HTMLInputElement).value).toBe('20');
    expect(get(goal).progress?.percent).toBe(60);
    expect(db.prepare('SELECT count(*) n FROM umeda_work_records').get()).toEqual({ n: 2 });
  });

  it('shows persisted versions and resolves a sync conflict through the real IPC without erasing the local journal', async () => {
    const create = { operation: 'create' as const, request_id: 'create-sync', kind: 'task' as const, title: 'Sync draft' };
    const created = await execute(create), id = created.items![0].id;
    const envelope = JSON.parse((db.prepare('SELECT envelope FROM umeda_work_outbox WHERE request_id=?').get(create.request_id) as { envelope: string }).envelope) as WorkEnvelope;
    await execute({ operation: 'update', request_id: 'local-edit', summary: 'Offline milestone', changes: [{ id, expected_revision: 1, description: '**Local version**', status: 'done' }] });
    const original = db.prepare("SELECT data FROM umeda_work_records WHERE request_id='local-edit'").get();
    const remote = createBetterSqliteDatabase(':memory:');
    try {
      for (const file of ['0149_umeda_work_management', '0150_exotic_valeria_richards', '0151_vengeful_bulldozer']) remote.exec(readFileSync(path.resolve(`drizzle/${file}.sql`), 'utf8'));
      runWorkStore(remote, envelope);
      const update: WorkEnvelope = { version: 1, actor: { kind: 'user' }, created_id: 'unused', now: 200,
        request: { operation: 'update', request_id: 'remote-edit', summary: 'Another device', changes: [{ id, expected_revision: 1, description: '**Shared version**' }] } };
      runWorkStore(remote, update);
      const commits = [envelope, update].map((e, n) => {
        const r = remote.prepare('SELECT fingerprint,data,result FROM umeda_work_records WHERE request_id=?').get(e.request.request_id) as { fingerprint: string; data: string; result: string };
        return { cursor: n + 1, envelope: e, fingerprint: r.fingerprint, record: JSON.parse(r.data), result: JSON.parse(r.result) };
      });
      await client.tx('umedaWork.replica', { operation: 'bind', scope: 'synthetic-relay' });
      await client.tx('umedaWork.replica', { operation: 'apply', feed: { epoch: 'synthetic', commits, cursor: 2, more: false } as WorkFeed });
      await client.tx('umedaWork.replica', { operation: 'reject', request_id: 'local-edit', error: 'WORK_VERSION_CONFLICT' });
      mount(); await screen.findByText('1 change(s) need review');
      const summary = screen.getByText('Offline milestone'), details = summary.closest('details')!;
      details.open = true; fireEvent(details, new Event('toggle'));
      await screen.findByText('Local version'); await screen.findByText('Shared version');
      fireEvent.click(screen.getByRole('button', { name: 'Use shared version' }));
      await screen.findByText('Saved on this device · no changes waiting to send');
      expect(get(id)).toMatchObject({ description: '**Shared version**', status: 'todo', revision: 2 });
      expect(db.prepare("SELECT data FROM umeda_work_records WHERE request_id='local-edit'").get()).toEqual(original);
    } finally { remote.close(); }
  });

  it('retrieves the committed receipt after a lost UI acknowledgement without creating a duplicate', async () => {
    mount(); await screen.findByRole('radio', { name: 'To-dos' }); bridge.dropAck = true;
    const id = await createViaUi('task', 'One small thing');
    expect(get(id).revision).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM umeda_work_items').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) n FROM umeda_work_records').get()).toEqual({ n: 1 });
  });
});
