/** Personal Umeda business data. Independent of execution Session and model context. */
export type WorkItemKind = 'goal' | 'project' | 'task';
export type WorkItemStatus = 'todo' | 'doing' | 'done' | 'blocked' | 'cancelled';
export interface WorkProgress { percent: number; basis: string }
export interface WorkItemFields {
  title: string;
  description: string;
  status: WorkItemStatus;
  project_ids: string[];
  goal_ids: string[];
  progress: WorkProgress | null;
}
export interface WorkItem extends WorkItemFields {
  schema_version: 1;
  id: string;
  kind: WorkItemKind;
  revision: number;
  created_at: number;
  updated_at: number;
}
export interface WorkItemChange extends Partial<WorkItemFields> { id: string; expected_revision: number }
export interface WorkVerification {
  description: string;
  outcome: 'reported_passed' | 'reported_failed' | 'not_run' | 'unknown';
  evidence?: string;
}
export type WorkManagementRequest =
  | { operation: 'sync_status' }
  | { operation: 'sync_conflict'; request_id: string }
  | { operation: 'sync_resolve'; request_id: string; choice: 'local' | 'remote' }
  | { operation: 'list'; kind?: WorkItemKind; query?: string; project_id?: string; goal_id?: string; after?: string; limit?: number }
  | { operation: 'get'; id: string; before_record?: number }
  | { operation: 'record'; request_id: string }
  | { operation: 'create'; request_id: string; kind: WorkItemKind; title: string; description?: string; project_ids?: string[]; goal_ids?: string[] }
  | { operation: 'update'; request_id: string; summary: string; changes: WorkItemChange[]; verification?: WorkVerification[] };
export type WorkManagementActor = { kind?: 'agent_report'; session_id: string; epoch: number; agent_kind: string } | { kind: 'user' };
export interface WorkManagementTransaction {
  request: WorkManagementRequest;
  actor: WorkManagementActor;
  created_id: string;
  now: number;
}

export type WorkItemSummary = Pick<WorkItem, 'id' | 'kind' | 'title' | 'status' | 'revision' | 'progress'> & Partial<Pick<WorkItem, 'project_ids' | 'goal_ids'>>;
export interface WorkRecordSummary {
  sequence: number;
  request_id: string;
  summary: string;
  created_at: number;
  actor: WorkManagementActor;
  verification_count: number;
  operation?: 'create' | 'update';
  created_title?: string;
}
export interface WorkProgressRecord {
  schema_version: 1;
  request_id: string;
  operation?: 'create' | 'update';
  summary: string;
  created_at: number;
  actor: WorkManagementActor;
  item_ids: string[];
  changes: { before: WorkItem | null; after: WorkItem }[];
  verification: WorkVerification[];
}
export interface WorkManagementResponse {
  ok?: boolean;
  errorCode?: string;
  hint?: string;
  items?: WorkItemSummary[];
  item?: WorkItem;
  records?: WorkRecordSummary[];
  record?: WorkProgressRecord;
  next_after?: string | null;
  next_before_record?: number | null;
  recorded_item_ids?: string[];
  request_id?: string;
  status?: string;
}
export interface WorkOwnerStamp { dataOwnerId: string | null; ownerGeneration: number }
export interface WorkManagementApi {
  syncConflict?(requestId: string, owner: WorkOwnerStamp): Promise<import('./workReplication').WorkConflict>;
  syncStatus?(owner: WorkOwnerStamp): Promise<import('./workReplication').WorkSyncStatus>;
  resolveSync?(requestId: string, choice: 'local' | 'remote', owner: WorkOwnerStamp): Promise<void>;
  available(owner: WorkOwnerStamp): Promise<boolean>;
  execute(request: WorkManagementRequest, owner: WorkOwnerStamp): Promise<WorkManagementResponse>;
  onChanged(listener: (owner: WorkOwnerStamp) => void): () => void;
}
export const WORK_MANAGEMENT_CHANNEL = 'umeda-work:execute';
export const WORK_MANAGEMENT_AVAILABLE = 'umeda-work:available';
export const WORK_MANAGEMENT_CHANGED = 'umeda-work:changed';

export const WORK_SYNC_STATUS_CHANNEL = 'umeda-work:sync-status';
export const WORK_SYNC_RESOLVE_CHANNEL = 'umeda-work:sync-resolve';

/** Compatibility projection for the first KOS snapshot import. Never rewrites stored data. */
export function splitWorkDescription(description: string): { body: string; metadataSuffix: string } {
  const footer = /\n\n---\nKOS 导入来源：[^\n]+\n原始状态：[^\n]+\n以下保留原始元数据；当前业务状态以 Umeda 为准，不自动回写原文档。\n\n```yaml\n[\s\S]*\n```\n?$/.exec(description);
  return footer ? { body: description.slice(0, footer.index), metadataSuffix: footer[0] } : { body: description, metadataSuffix: '' };
}

export const WORK_SYNC_CONFLICT_CHANNEL = 'umeda-work:sync-conflict';
