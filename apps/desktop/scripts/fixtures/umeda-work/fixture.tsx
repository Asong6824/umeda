import { mountPage, subscription } from '../../ui-page/harness';
import type { WorkItem, WorkManagementRequest, WorkRecordSummary, WorkProgressRecord } from '@cindy/maker-shared/work-management';
import { WorkPage } from '../../../src/renderer/features/work-management/WorkPage';

const stamp = { dataOwnerId: 'work-fixture', ownerGeneration: 1 };
void mountPage({
  host: ctx => {
    const item = (id: string, kind: WorkItem['kind'], title: string): WorkItem => ({ schema_version: 1, id, kind, title, description: '', status: kind === 'task' ? 'todo' : 'doing', project_ids: [], goal_ids: [], progress: null, revision: 1, created_at: 1795305600000, updated_at: 1795305600000 });
    let items: WorkItem[] = ctx.case === 'empty' ? [] : [
      { ...item('goal', 'goal', 'Build durable habits'), description: 'Keep learning and turn useful ideas into practice.', progress: { percent: 25, basis: 'First reading milestone completed.' } },
      { ...item('project', 'project', 'Reading companion'), goal_ids: ['goal'] },
      { ...item('task', 'task', 'Read a chapter'), project_ids: ['project'] },
      { ...item('task-2', 'task', ctx.case === 'long' ? 'Review a longer research note and preserve its sources, unanswered questions, and useful connections to the next project milestone' : 'Summarize useful ideas'), project_ids: ['project'] },
    ];
    const records = new Map<string, WorkRecordSummary[]>();
    const fullRecords = new Map<string, WorkProgressRecord>();
    if (ctx.case === 'imported') {
      items[0].description = '# Build durable habits\n\n## Outcomes\n\n**A useful milestone**\n\n- Read a chapter\n\n| Item | Result |\n| --- | --- |\n| Reading | Started |\n\nSee [[Reading companion]].\n\n---\nKOS 导入来源：30_目标/Habits.md\n原始状态：active\n以下保留原始元数据；当前业务状态以 Umeda 为准，不自动回写原文档。\n\n```yaml\ntype: goal\nallocation_weight: 20\n```\n';
      const summary: WorkRecordSummary = { sequence: 1, request_id: 'imported-record', summary: 'Reader delivered', created_at: 1795305600000, actor: { kind: 'user' }, verification_count: 1 };
      records.set('goal', [summary]);
      fullRecords.set(summary.request_id, { schema_version: 1, ...summary, item_ids: ['project'], changes: [{ before: { ...items[1], status: 'todo' }, after: items[1] }], verification: [{ description: 'Readback matched', outcome: 'reported_passed' }] });
    }
    const changed = subscription('work-changed');
    let hasConflict = ctx.case === 'conflict';
    return { workManagement: {
      available: async () => true,
      syncStatus: async () => ({ scope: 'fixture', cursor: 2, queued: hasConflict ? 1 : 0, conflict_count: hasConflict ? 1 : 0, conflicts: hasConflict ? [{ request_id: 'fixture-conflict', error: 'WORK_VERSION_CONFLICT', summary: 'Offline progress update' }] : [] }),
      syncConflict: async () => ({ record: { summary: 'Offline progress update' }, local: [{ ...items[0], description: '**Local draft** remains available.', progress: { percent: 40, basis: 'Local milestone' } }], remote: [{ ...items[0], description: '**Shared update** from another device.', progress: { percent: 20, basis: 'Shared milestone' } }] }),
      resolveSync: async () => { hasConflict = false; (window as unknown as { __uiPage: { emit(name: string, value: unknown): void } }).__uiPage.emit('work-changed', stamp); },
      onChanged: changed,
      execute: async (request: WorkManagementRequest) => {
        if (request.operation === 'list') return { ok: true, items: items.filter(value => (!request.kind || value.kind === request.kind) && (!request.query || value.title.toLowerCase().includes(request.query.toLowerCase())) && (!request.project_id || value.project_ids.includes(request.project_id)) && (!request.goal_id || value.goal_ids.includes(request.goal_id) || value.project_ids.some(id => items.find(project => project.id === id)?.goal_ids.includes(request.goal_id!)))), next_after: null };
        if (request.operation === 'get') return { ok: true, item: items.find(value => value.id === request.id), records: records.get(request.id) ?? [], next_before_record: null };
        if (request.operation === 'record') return { ok: true, record: fullRecords.get(request.request_id) };
        if (request.operation === 'create') {
          const value = { ...item(`created-${items.length}`, request.kind, request.title), description: request.description ?? '', project_ids: request.project_ids ?? [], goal_ids: request.goal_ids ?? [] };
          items = [...items, value]; return { ok: true, items: [value] };
        }
        if (request.operation === 'update') {
          const previous = items;
          for (const change of request.changes) {
            const { expected_revision: _revision, ...patch } = change;
            items = items.map(value => value.id === change.id ? { ...value, ...patch, revision: value.revision + 1 } : value);
            records.set(change.id, [{ sequence: 1, request_id: request.request_id, summary: request.summary, created_at: 1795305600000, actor: { kind: 'user' }, verification_count: 0 }]);
          }
          fullRecords.set(request.request_id, { schema_version: 1, request_id: request.request_id, summary: request.summary, created_at: 1795305600000, actor: { kind: 'user' }, item_ids: request.changes.map(change => change.id), changes: request.changes.map(change => ({ before: previous.find(value => value.id === change.id)!, after: items.find(value => value.id === change.id)! })), verification: [] });
          (window as unknown as { __uiPage: { emit(name: string, value: unknown): void } }).__uiPage.emit('work-changed', stamp);
          return { ok: true, items: request.changes.map(change => items.find(value => value.id === change.id)) };
        }
        throw new Error('No raw work records in this UI fixture');
      },
    } };
  },
  render: () => <WorkPage />,
});
