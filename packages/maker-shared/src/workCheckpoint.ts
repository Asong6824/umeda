/** Application work facts; independent of any Agent's native conversation state. */
export interface WorkCheckpointData {
  objective: string;
  acceptance: string[];
  completed: string[];
  decisions: string[];
  next: string[];
  blockers: string[];
  verification: Array<{ description: string; outcome: 'reported_passed' | 'reported_failed' | 'not_run' | 'unknown'; evidence?: string }>;
  references: Array<{ label: string; ref: string }>;
}
export const WORK_CHECKPOINT_TEXT_LIMIT = 1000;
export const WORK_CHECKPOINT_LIST_LIMIT = 20;
export const WORK_CHECKPOINT_MAX_BYTES = 64000;

/** Stored input is validated too; a corrupt record must not silently become an empty checkpoint. */
export function parseWorkCheckpoint(value: unknown): WorkCheckpointData {
  const invalid = (): never => { throw new Error('INVALID_WORK_CHECKPOINT'); };
  const object = (value: unknown, keys: string[]): Record<string, unknown> => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) return invalid();
    return value as Record<string, unknown>;
  };
  const text = (value: unknown): string => typeof value === 'string' && value.length <= WORK_CHECKPOINT_TEXT_LIMIT ? value : invalid();
  const list = <T>(value: unknown, parse: (entry: unknown) => T): T[] =>
    Array.isArray(value) && value.length <= WORK_CHECKPOINT_LIST_LIMIT ? value.map(parse) : invalid();
  const raw = object(value, ['objective', 'acceptance', 'completed', 'decisions', 'next', 'blockers', 'verification', 'references']);
  const result: WorkCheckpointData = {
    objective: text(raw.objective), acceptance: list(raw.acceptance, text), completed: list(raw.completed, text),
    decisions: list(raw.decisions, text), next: list(raw.next, text), blockers: list(raw.blockers, text),
    verification: list(raw.verification, entry => {
      const item = object(entry, ['description', 'outcome', 'evidence']);
      if (!['reported_passed', 'reported_failed', 'not_run', 'unknown'].includes(String(item.outcome))) return invalid();
      return { description: text(item.description), outcome: item.outcome as WorkCheckpointData['verification'][number]['outcome'],
        ...(item.evidence === undefined ? {} : { evidence: text(item.evidence) }) };
    }),
    references: list(raw.references, entry => { const item = object(entry, ['label', 'ref']); return { label: text(item.label), ref: text(item.ref) }; }),
  };
  if (!result.objective.trim() || new TextEncoder().encode(JSON.stringify(result)).length > WORK_CHECKPOINT_MAX_BYTES) return invalid();
  return result;
}

export type WorkspaceObservation =
  | { status: 'observed'; observedAt: number; workingDir: string; head: string | null; branch: string; dirty: boolean; changedPathCount: number; statusDigest: string }
  | { status: 'unavailable'; observedAt: number; reason: 'remote_workspace' | 'missing_workdir' | 'git_unavailable' };
export interface WorkCheckpointRecord {
  version: 1;
  sessionId: string;
  epoch: number;
  revision: number;
  savedAt: number;
  inputHash: string;
  author: { kind: 'agent_report'; agentKind: string; sessionInstanceId?: string };
  checkpoint: WorkCheckpointData;
  workspace: WorkspaceObservation;
}

/** Bounded data for the existing user-message handoff; complete details remain queryable. */
export function renderWorkCheckpoint(record: WorkCheckpointRecord, currentWorkspace: WorkspaceObservation): string {
  const short = (items: string[]) => items.slice(0, 2).map(item => item.slice(0, 100));
  const projected = {
    revision: record.revision, saved_at: record.savedAt, provenance: 'agent_report_not_host_verified',
    objective: record.checkpoint.objective.slice(0, 400), acceptance: short(record.checkpoint.acceptance),
    completed: short(record.checkpoint.completed), decisions: short(record.checkpoint.decisions), next: short(record.checkpoint.next),
    blockers: short(record.checkpoint.blockers),
    verification: record.checkpoint.verification.slice(0, 3).map(item => ({ description: item.description.slice(0, 140), outcome: item.outcome })),
    saved_workspace: record.workspace, current_workspace: currentWorkspace,
    details: 'get_work_checkpoint / list_work_records for this task. Git status is metadata, not a snapshot of dirty file bytes. Recheck real files before changes.',
  };
  // One JSON line keeps record text separate from handoff headings. Escape heading punctuation in data.
  // Paths may be very long; if needed keep an explicit retrieval reference rather than cutting JSON.
  const encoded = JSON.stringify(projected).replace(/=/g, '\\u003d');
  return encoded.length <= 4000 ? encoded : JSON.stringify({ revision: record.revision, saved_at: record.savedAt,
    provenance: 'agent_report_not_host_verified', objective: record.checkpoint.objective.slice(0, 400),
    next: short(record.checkpoint.next), blockers: short(record.checkpoint.blockers),
    details: 'Checkpoint projection exceeds the handoff budget. Read get_work_checkpoint before continuing.' });
}
