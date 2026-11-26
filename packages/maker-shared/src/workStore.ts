import type { WorkItem, WorkItemFields, WorkManagementTransaction } from './workManagement';

/** Small synchronous SQLite port: desktop worker, Cloudflare SQLite and native SQLite adapters. */
export interface WorkSqlDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[]; run(...params: unknown[]): unknown };
  transaction<T>(operation: () => T): () => T;
}

/** Self-contained so the existing desktop inline-worker fallback can embed it. */
export function runWorkStore(db: WorkSqlDatabase, input: WorkManagementTransaction): Record<string, unknown> {
  const byteLength = (value: string): number => {
    let size = 0;
    for (const character of value) { const code = character.codePointAt(0)!; size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
    return size;
  };
  const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
  const object = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return fail('WORK_INVALID_INPUT');
    return value as Record<string, unknown>;
  };
  const text = (value: unknown, max: number, nonempty = true): string => {
    if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim())) return fail('WORK_INVALID_INPUT');
    return nonempty ? value.trim() : value;
  };
  const id = (value: unknown): string => { const next = text(value, 128); return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(next) ? next : fail('WORK_INVALID_INPUT'); };
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value) || value.length > 20) return fail('WORK_INVALID_INPUT');
    return [...new Set(value.map(id))].sort();
  };
  const integer = (value: unknown, min = 0): number => Number.isSafeInteger(value) && Number(value) >= min ? Number(value) : fail('WORK_INVALID_INPUT');
  const fields = (raw: Record<string, unknown>): Partial<WorkItemFields> => {
    const result: Partial<WorkItemFields> = {};
    if (raw.title !== undefined) result.title = text(raw.title, 300);
    if (raw.description !== undefined) result.description = text(raw.description, 8000, false);
    if (raw.status !== undefined) {
      if (typeof raw.status !== 'string' || !['todo', 'doing', 'done', 'blocked', 'cancelled'].includes(raw.status)) fail('WORK_INVALID_INPUT');
      result.status = raw.status as WorkItemFields['status'];
    }
    if (raw.project_ids !== undefined) result.project_ids = ids(raw.project_ids);
    if (raw.goal_ids !== undefined) result.goal_ids = ids(raw.goal_ids);
    if (raw.progress !== undefined) {
      if (raw.progress === null) result.progress = null;
      else {
        const p = object(raw.progress, ['percent', 'basis']);
        if (typeof p.percent !== 'number' || !Number.isFinite(p.percent) || p.percent < 0 || p.percent > 100) fail('WORK_INVALID_INPUT');
        result.progress = { percent: p.percent as number, basis: text(p.basis, 2000) };
      }
    }
    return result;
  };
  const request = input.request;
  if (!request || byteLength(JSON.stringify(request)) > 64 * 1024) fail('WORK_INVALID_INPUT');
  const actor = input.actor?.kind === 'user' ? { kind: 'user' as const }
    : { kind: 'agent_report' as const, session_id: text(input.actor?.session_id, 512), epoch: integer(input.actor?.epoch), agent_kind: text(input.actor?.agent_kind, 80) };
  const now = integer(input.now), createdId = id(input.created_id);
  const item = (itemId: string): WorkItem => {
    const row = db.prepare('SELECT data FROM umeda_work_items WHERE id=?').get(itemId) as { data: string } | undefined;
    if (!row) return fail('WORK_NOT_FOUND');
    let value: WorkItem;
    try { value = JSON.parse(row.data) as WorkItem; } catch { return fail('WORK_DATA_UNREADABLE'); }
    if (value.schema_version !== 1 || value.id !== itemId) return fail('WORK_DATA_UNREADABLE');
    return value;
  };
  return db.transaction(() => {
    if (request.operation === 'list') {
      object(request, ['operation', 'kind', 'query', 'project_id', 'goal_id', 'after', 'limit']);
      const params: unknown[] = [], where: string[] = [];
      if (request.kind !== undefined) {
        if (!['goal', 'project', 'task'].includes(request.kind)) fail('WORK_INVALID_INPUT');
        where.push('kind=?'); params.push(request.kind);
      }
      if (request.query !== undefined) { where.push("title LIKE ? ESCAPE '\\'"); params.push(`%${text(request.query, 200, false).replace(/[\\%_]/g, '\\$&')}%`); }
      for (const key of ['project_id', 'goal_id'] as const) if (request[key] !== undefined) {
        const value = id(request[key]);
        if (key === 'goal_id') {
          where.push("(EXISTS(SELECT 1 FROM json_each(umeda_work_items.data,'$.goal_ids') WHERE value=?) OR EXISTS(SELECT 1 FROM json_each(umeda_work_items.data,'$.project_ids') link JOIN umeda_work_items p ON p.id=link.value JOIN json_each(p.data,'$.goal_ids') goal WHERE p.kind='project' AND goal.value=?))");
          params.push(value, value);
        } else { where.push("EXISTS(SELECT 1 FROM json_each(data,'$.project_ids') WHERE value=?)"); params.push(value); }
      }
      if (request.after !== undefined) { where.push('id>?'); params.push(id(request.after)); }
      const limit = request.limit === undefined ? 20 : integer(request.limit, 1);
      if (limit > 50) fail('WORK_INVALID_INPUT');
      const rows = db.prepare(`SELECT data FROM umeda_work_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id LIMIT ?`).all(...params, limit + 1) as { data: string }[];
      const items: Record<string, unknown>[] = [];
      for (const row of rows.slice(0, limit)) {
        const v = JSON.parse(row.data) as WorkItem;
        const summary = { id: v.id, kind: v.kind, title: v.title, status: v.status, revision: v.revision, progress: v.progress, project_ids: v.project_ids, goal_ids: v.goal_ids };
        if (items.length && byteLength(JSON.stringify([...items, summary])) > 48 * 1024) break;
        items.push(summary);
      }
      return { items, next_after: rows.length > items.length ? items.at(-1)?.id : null, scope: 'application', sync_status: 'local_saved' };
    }
    if (request.operation === 'get') {
      object(request, ['operation', 'id', 'before_record']);
      const value = item(id(request.id));
      const before = request.before_record === undefined ? Number.MAX_SAFE_INTEGER : integer(request.before_record, 1);
      const rows = db.prepare('SELECT r.sequence,COALESCE(c.data,r.data) data FROM umeda_work_records r LEFT JOIN umeda_work_confirmed_records c ON c.request_id=r.request_id JOIN umeda_work_record_items i ON i.request_id=r.request_id WHERE i.item_id=? AND r.sequence<? ORDER BY r.sequence DESC LIMIT 6').all(value.id, before) as { sequence: number; data: string }[];
      const records: Record<string, unknown>[] = [];
      for (const row of rows.slice(0, 5)) {
        const r = JSON.parse(row.data);
        const operation = r.operation ?? (r.changes.every((change: { before: unknown }) => change.before === null) ? 'create' : 'update');
        const summary = { sequence: row.sequence, request_id: r.request_id, summary: r.summary, created_at: r.created_at, actor: r.actor, affected_item_count: r.item_ids.length, verification_count: r.verification.length,
          operation, ...(operation === 'create' ? { created_title: r.changes[0].after.title } : {}) };
        if (records.length && byteLength(JSON.stringify({ item: value, records: [...records, summary] })) > 64 * 1024) break;
        records.push(summary);
      }
      return { item: value, records, next_before_record: rows.length > records.length ? records.at(-1)?.sequence : null, scope: 'application', sync_status: 'local_saved' };
    }
    if (request.operation === 'record') {
      object(request, ['operation', 'request_id']);
      const row = db.prepare('SELECT COALESCE(c.data,r.data) data FROM umeda_work_records r LEFT JOIN umeda_work_confirmed_records c USING(request_id) WHERE r.request_id=?').get(id(request.request_id)) as { data: string } | undefined;
      if (!row) return fail('WORK_NOT_FOUND');
      return { record: JSON.parse(row.data), scope: 'application', sync_status: 'local_saved' };
    }
    let normalized: Record<string, unknown>;
    if (request.operation === 'create') {
      object(request, ['operation', 'request_id', 'kind', 'title', 'description', 'project_ids', 'goal_ids']);
      if (!['goal', 'project', 'task'].includes(request.kind)) fail('WORK_INVALID_INPUT');
      normalized = { operation: 'create', request_id: id(request.request_id), kind: request.kind, title: text(request.title, 300),
        description: request.description === undefined ? '' : text(request.description, 8000, false), project_ids: ids(request.project_ids ?? []), goal_ids: ids(request.goal_ids ?? []) };
    } else if (request.operation === 'update') {
      object(request, ['operation', 'request_id', 'summary', 'changes', 'verification']);
      if (!Array.isArray(request.changes) || !request.changes.length || request.changes.length > 20) fail('WORK_INVALID_INPUT');
      const changes = request.changes.map(change => {
        const raw = object(change, ['id', 'expected_revision', 'title', 'description', 'status', 'project_ids', 'goal_ids', 'progress']);
        return { id: id(raw.id), expected_revision: integer(raw.expected_revision, 1), ...fields(raw) };
      }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      if (new Set(changes.map(c => c.id)).size !== changes.length) fail('WORK_INVALID_INPUT');
      const rawVerification = request.verification ?? [];
      if (!Array.isArray(rawVerification) || rawVerification.length > 20) fail('WORK_INVALID_INPUT');
      const verification = rawVerification.map(v => {
        const raw = object(v, ['description', 'outcome', 'evidence']);
        if (typeof raw.outcome !== 'string' || !['reported_passed', 'reported_failed', 'not_run', 'unknown'].includes(raw.outcome)) fail('WORK_INVALID_INPUT');
        return { description: text(raw.description, 1000), outcome: raw.outcome, ...(raw.evidence === undefined ? {} : { evidence: text(raw.evidence, 2000, false) }) };
      });
      normalized = { operation: 'update', request_id: id(request.request_id), summary: text(request.summary, 4000), changes, verification };
    } else return fail('WORK_INVALID_INPUT');
    const fingerprint = JSON.stringify(normalized), requestId = normalized.request_id as string;
    const oldReceipt = db.prepare('SELECT fingerprint,result FROM umeda_work_records WHERE request_id=?').get(requestId) as { fingerprint: string; result: string } | undefined;
    if (oldReceipt) return oldReceipt.fingerprint === fingerprint ? JSON.parse(oldReceipt.result) : fail('WORK_REQUEST_REUSED');
    const updates: WorkItem[] = [], previous: WorkItem[] = [];
    if (request.operation === 'create') {
      if (db.prepare('SELECT 1 FROM umeda_work_items WHERE id=?').get(createdId)) fail('WORK_VERSION_CONFLICT');
      updates.push({ schema_version: 1, id: createdId, kind: request.kind,
      title: normalized.title as string, description: normalized.description as string, status: request.kind === 'task' ? 'todo' : 'doing',
      project_ids: normalized.project_ids as string[], goal_ids: normalized.goal_ids as string[], progress: null, revision: 1, created_at: now, updated_at: now });
    }
    else for (const c of normalized.changes as ({ id: string; expected_revision: number } & Partial<WorkItemFields>)[]) {
      const value = item(c.id);
      if (value.revision !== c.expected_revision) return fail('WORK_VERSION_CONFLICT');
      previous.push(value);
      const { id: _id, expected_revision: _expected, ...patch } = c;
      updates.push({ ...value, ...patch, revision: value.revision + 1, updated_at: now });
    }
    const updated = new Map(updates.map(v => [v.id, v]));
    const lookup = (itemId: string) => updated.get(itemId) ?? item(itemId);
    const affected = new Set(updates.map(v => v.id));
    for (const value of updates) {
      if ((value.kind !== 'task' && value.project_ids.length) || (value.kind === 'goal' && value.goal_ids.length) || (value.kind === 'task' && value.progress !== null)) fail('WORK_INVALID_RELATION');
      for (const projectId of value.project_ids) if (lookup(projectId).kind !== 'project') fail('WORK_INVALID_RELATION');
      for (const goalId of value.goal_ids) if (lookup(goalId).kind !== 'goal') fail('WORK_INVALID_RELATION');
    }
    // A task's work appears in its project's and goal's journals without inventing their completion.
    for (const value of [...previous, ...updates]) {
      value.goal_ids.forEach(v => affected.add(v));
      for (const projectId of value.project_ids) {
        affected.add(projectId); lookup(projectId).goal_ids.forEach(v => affected.add(v));
      }
    }
    for (const value of updates) db.prepare('INSERT INTO umeda_work_items(id,kind,title,status,data,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,status=excluded.status,data=excluded.data,revision=excluded.revision,updated_at=excluded.updated_at').run(value.id, value.kind, value.title, value.status, JSON.stringify(value), value.revision, value.created_at, value.updated_at);
    const result = { items: request.operation === 'create' ? updates : updates.map(v => ({ id: v.id, kind: v.kind, title: v.title, status: v.status, revision: v.revision, progress: v.progress })),
      request_id: requestId, recorded_item_ids: [...affected].sort(), status: 'local_saved', sync_status: 'local_saved', scope: 'application' };
    const record = { schema_version: 1, request_id: requestId, operation: request.operation, summary: request.operation === 'create' ? `Created: ${updates[0].title}` : normalized.summary,
      created_at: now, actor, item_ids: result.recorded_item_ids,
      changes: updates.map((value, i) => ({ before: previous[i] ?? null, after: value })), verification: normalized.verification ?? [] };
    db.prepare('INSERT INTO umeda_work_records(request_id,fingerprint,data,result,created_at) VALUES(?,?,?,?,?)').run(requestId, fingerprint, JSON.stringify(record), JSON.stringify(result), now);
    for (const itemId of affected) db.prepare('INSERT INTO umeda_work_record_items(request_id,item_id) VALUES(?,?)').run(requestId, itemId);
    return result;
  })();
}
