// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../../../i18n/locales/en/common.json';
import type { WorkItem, WorkItemKind, WorkManagementRequest, WorkManagementResponse, WorkOwnerStamp } from '@cindy/maker-shared/work-management';
const state = vi.hoisted(() => ({ owner: { dataOwnerId: 'fixture', dataOwnerGeneration: 1 }, error: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => state.owner }));
vi.mock('@/lib/toast', () => ({ toast: { error: state.error } }));
import { WorkPage } from '../WorkPage';
import { WorkItemForm } from '../WorkItemForm';

// Value: user stories 5/8 require a usable UI over the shared host API, live Agent
// changes, scoped late replies and idempotent save retry. Existing MCP/DB tests
// cannot observe rendered data or editor lifecycle. Minimal failures: two saves
// before acknowledgement, old-owner list response, progress without its basis.
// Tier: unit; real React/standard controls, isolated host API, no disk/network.
// Standalone duration: 2.57s locally (2026-11-22, including reading regressions).
const i18n = createInstance();
void i18n.init({ lng: 'en', resources: { en: { common: en } }, defaultNS: 'common', initAsync: false });
const row = (id: string, kind: WorkItemKind, title: string): WorkItem => ({ schema_version: 1, id, kind, title, description: '', status: kind === 'task' ? 'todo' : 'doing', project_ids: [], goal_ids: [], progress: null, revision: 1, created_at: 1, updated_at: 1 });
const importFooter = '\n\n---\nKOS 导入来源：30_目标/Learn.md\n原始状态：active\n以下保留原始元数据；当前业务状态以 Umeda 为准，不自动回写原文档。\n\n```yaml\ntype: goal\nallocation_weight: 20\n```\n';
const mount = (component = <WorkPage />) => render(<StrictMode><I18nextProvider i18n={i18n}>{component}</I18nextProvider></StrictMode>);
describe('work management UI', () => {
  let items: WorkItem[], listeners: Set<(owner: WorkOwnerStamp) => void>, execute: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    state.owner = { dataOwnerId: 'fixture', dataOwnerGeneration: 1 }; vi.clearAllMocks();
    const goal = row('goal', 'goal', 'Learn systems'), project = { ...row('project', 'project', 'Reader'), goal_ids: ['goal'] };
    items = [goal, project, { ...row('task', 'task', 'Read a chapter'), project_ids: ['project'] }]; listeners = new Set();
    execute = vi.fn(async (request: WorkManagementRequest): Promise<WorkManagementResponse> => {
      if (request.operation === 'list') return { ok: true, items: items.filter(v => (!request.kind || v.kind === request.kind) && (!request.project_id || v.project_ids.includes(request.project_id)) && (!request.goal_id || v.goal_ids.includes(request.goal_id))), next_after: null };
      if (request.operation === 'get') return { ok: true, item: items.find(v => v.id === request.id), records: [], next_before_record: null };
      return { ok: true, items: [] };
    });
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { workManagement: { available: vi.fn(async () => true), execute, onChanged: (cb: (owner: WorkOwnerStamp) => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; } } } });
  });
  afterEach(cleanup);
  const notify = () => act(() => { for (const fn of listeners) fn({ dataOwnerId: 'fixture', ownerGeneration: 1 }); });

  it('creates a title-only to-do from the real form and shows the persisted item', async () => {
    execute.mockImplementation(async (request: WorkManagementRequest) => {
      if (request.operation === 'create') { const value = row('new-task', request.kind, request.title); items.push(value); return { ok: true, items: [value] }; }
      if (request.operation === 'get') return { ok: true, item: items.find(v => v.id === request.id), records: [] };
      return { ok: true, items: items.filter(v => request.operation !== 'list' || !request.kind || v.kind === request.kind), next_after: null };
    });
    mount();
    await screen.findByText('Read a chapter');
    fireEvent.click(screen.getByRole('button', { name: 'New to-do' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Make a note' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ operation: 'create', kind: 'task', title: 'Make a note', description: '', project_ids: [], goal_ids: [], request_id: expect.any(String) }), { dataOwnerId: 'fixture', ownerGeneration: 1 });
    expect(await screen.findByRole('heading', { name: 'Make a note' })).toBeTruthy();
  });

  it('marks a to-do complete through a versioned command and refreshes from the same host records', async () => {
    mount(); await screen.findByText('Read a chapter');
    execute.mockImplementationOnce(async (request: WorkManagementRequest) => {
      expect(request).toMatchObject({ operation: 'update', changes: [{ id: 'task', expected_revision: 1, status: 'done' }] });
      items[2] = { ...items[2], status: 'done', revision: 2 };
      return { ok: true, items: [items[2]] };
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Read a chapter' }));
    await screen.findByText('Show completed and cancelled (1)');
    expect(screen.queryByRole('checkbox', { name: 'Complete Read a chapter' })).toBeNull();
    fireEvent.click(screen.getByLabelText('Show completed and cancelled (1)'));
    expect(screen.getByRole('checkbox', { name: 'Reopen Read a chapter' }).getAttribute('aria-checked')).toBe('true');
  });

  it('shows related to-dos and live Agent progress without loading model context', async () => {
    mount(); await screen.findByText('Read a chapter');
    fireEvent.click(screen.getByRole('radio', { name: 'Projects' }));
    fireEvent.click(await screen.findByRole('button', { name: /Reader.*In progress/ }));
    await screen.findByRole('heading', { name: 'Linked to-dos' });
    expect(within(screen.getByRole('complementary')).getByText('Read a chapter')).toBeTruthy();
    // Re-selecting the active row must not clear its detail without a refetch.
    fireEvent.click(screen.getByRole('button', { name: /Reader.*In progress/ }));
    expect(screen.getByRole('heading', { name: 'Reader' })).toBeTruthy();
    items[1] = { ...items[1], progress: { percent: 60, basis: 'Reader milestone delivered' }, revision: 2 };
    notify();
    expect(await screen.findByText('Reader milestone delivered')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('60');
    expect(execute.mock.calls.every(([request]) => ['list', 'get'].includes(request.operation))).toBe(true);
  });

  it('requires a reason for a changed percentage and submits only changed fields', async () => {
    const goal = items[0], save = vi.fn(async () => ({ ok: true })), close = vi.fn();
    mount(<WorkItemForm kind="goal" item={goal} catalog={{ goal: [goal], project: [], task: [] }} save={save} close={close} />);
    fireEvent.change(screen.getByLabelText('Progress (%)'), { target: { value: '40' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a percentage from 0 to 100 and explain the progress.')).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Progress note (optional)'), { target: { value: 'First milestone completed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ operation: 'update', summary: 'First milestone completed', changes: [{ id: 'goal', expected_revision: 1, progress: { percent: 40, basis: 'First milestone completed' } }] }));
  });

  it('blocks duplicate submits and retries the identical command after a lost acknowledgement', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('ack lost')).mockResolvedValueOnce({ ok: true, items: [row('created', 'task', 'One thing')] });
    const close = vi.fn();
    mount(<WorkItemForm kind="task" catalog={{ goal: [], project: [], task: [] }} save={save} close={close} />);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'One thing' } });
    const form = screen.getByRole('button', { name: 'Save' }).closest('form')!;
    fireEvent.submit(form); fireEvent.submit(form);
    await waitFor(() => expect(close).toHaveBeenCalledWith('created'));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[0][0]).toEqual(save.mock.calls[1][0]);
  });

  it('drops old-owner data and invalidations when the owner changes', async () => {
    let resolveOld!: (value: WorkManagementResponse) => void;
    execute.mockImplementation((request: WorkManagementRequest, owner: WorkOwnerStamp) => {
      if (owner.dataOwnerId === 'fixture' && request.operation === 'list' && request.kind === 'task') return new Promise(resolve => { resolveOld = resolve; });
      return Promise.resolve({ ok: true, items: request.operation === 'list' && request.kind === 'task' ? [row('new', 'task', 'New owner task')] : [], next_after: null });
    });
    const view = mount();
    await waitFor(() => expect(resolveOld).toBeTruthy());
    state.owner = { dataOwnerId: 'other-owner', dataOwnerGeneration: 2 };
    view.rerender(<StrictMode><I18nextProvider i18n={i18n}><WorkPage /></I18nextProvider></StrictMode>);
    await screen.findByText('New owner task');
    await act(async () => { resolveOld({ ok: true, items: [row('old', 'task', 'Private old task')] }); });
    expect(screen.queryByText('Private old task')).toBeNull();
    const count = execute.mock.calls.length;
    notify();
    expect(execute).toHaveBeenCalledTimes(count);
  });

  it('drops a late history page after selecting a different object for the same owner', async () => {
    const original = execute.getMockImplementation()!;
    let resolveHistory!: (result: WorkManagementResponse) => void;
    execute.mockImplementation((request: WorkManagementRequest, owner: WorkOwnerStamp) => {
      if (request.operation === 'get' && request.id === 'goal') {
        if (request.before_record) return new Promise(resolve => { resolveHistory = resolve; });
        return Promise.resolve({ ok: true, item: items[0], records: [], next_before_record: 7 });
      }
      return original(request, owner);
    });
    mount(); await screen.findByText('Read a chapter');
    fireEvent.click(screen.getByRole('radio', { name: 'Goals' }));
    fireEvent.click(await screen.findByRole('button', { name: /Learn systems.*In progress/ }));
    const history = await screen.findByRole('region', { name: 'Progress history' });
    fireEvent.click(await within(history).findByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(resolveHistory).toBeTruthy());
    fireEvent.click(screen.getByRole('radio', { name: 'Projects' }));
    fireEvent.click(await screen.findByRole('button', { name: /Reader.*In progress/ }));
    await screen.findByRole('heading', { name: 'Reader' });
    await act(async () => { resolveHistory({ ok: true, records: [{ sequence: 6, request_id: 'old-history', summary: 'Previous goal history', created_at: 1, actor: { kind: 'user' }, verification_count: 0 }], next_before_record: null }); });
    expect(screen.queryByText('Previous goal history')).toBeNull();
  });

  // Screenshot regression: imported YAML leaked into plain text, history had no
  // action, and related-object navigation retained the old pane's scroll offset.
  // These rendered outcomes are absent from the existing persistence tests.
  it('renders imported Markdown without metadata and preserves the original metadata when editing', async () => {
    items[0].description = '## Outcomes\n\n**A useful milestone**\n\n- Read a chapter\n\nSee [[Reader]].' + importFooter;
    mount(); await screen.findByText('Read a chapter');
    fireEvent.click(screen.getByRole('radio', { name: 'Goals' }));
    fireEvent.click(await screen.findByRole('button', { name: /Learn systems.*In progress/ }));
    expect(await screen.findByRole('heading', { name: 'Outcomes' })).toBeTruthy();
    expect(screen.queryByText(/allocation_weight/)).toBeNull();
    expect(screen.getByText('A useful milestone').tagName).toBe('STRONG');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByLabelText('Description (optional)') as HTMLTextAreaElement;
    expect(field.value).not.toContain('allocation_weight');
    fireEvent.change(field, { target: { value: field.value + '\nNew paragraph' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const command = execute.mock.calls.find(([r]) => r.operation === 'update')![0];
    expect(command.changes[0].description).toContain('New paragraph' + importFooter);
    // The body reference uses the same stable identity as the related-object chip.
    const pane = screen.getByRole('complementary'); pane.scrollTop = 850;
    fireEvent.click(within(pane).getAllByRole('button', { name: 'Reader' })[0]);
    await screen.findByRole('heading', { name: 'Reader' });
    expect(screen.getByRole('complementary').scrollTop).toBe(0);
  });

  it('opens a full progress record and navigates to its changed object at the top of the detail pane', async () => {
    const original = execute.getMockImplementation()!;
    execute.mockImplementation((request: WorkManagementRequest, owner: WorkOwnerStamp) => {
      if (request.operation === 'record') return Promise.resolve({ ok: true, record: { schema_version: 1, request_id: 'delivery', summary: 'Reader delivered', created_at: 1, actor: { kind: 'user' }, item_ids: ['project'], changes: [{ before: { ...items[1], status: 'todo', goal_ids: [] }, after: items[1] }], verification: [{ description: 'Readback matched', outcome: 'reported_passed' }] } });
      if (request.operation === 'get' && request.id === 'goal') return Promise.resolve({ ok: true, item: items[0], records: [{ sequence: 1, request_id: 'delivery', summary: 'Reader delivered', created_at: 1, actor: { kind: 'user' }, verification_count: 1 }] });
      return original(request, owner);
    });
    mount(); await screen.findByText('Read a chapter');
    fireEvent.click(screen.getByRole('radio', { name: 'Goals' }));
    fireEvent.click(await screen.findByRole('button', { name: /Learn systems.*In progress/ }));
    const pane = await screen.findByRole('complementary'); pane.scrollTop = 850;
    fireEvent.click(await screen.findByRole('button', { name: /Reader delivered/ }));
    let dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('Readback matched')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Learn systems' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByRole('complementary').scrollTop).toBe(0);
    screen.getByRole('complementary').scrollTop = 850;
    fireEvent.click(screen.getByRole('button', { name: /Reader delivered/ }));
    dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('Readback matched');
    fireEvent.click(within(dialog).getByRole('button', { name: /Reader/ }));
    await screen.findByRole('heading', { name: 'Reader' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('complementary').scrollTop).toBe(0);
  });
});
