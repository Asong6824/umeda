import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseWorkCheckpoint, WORK_CHECKPOINT_MAX_BYTES, type WorkCheckpointData, type WorkCheckpointRecord, type WorkspaceObservation } from '@cindy/maker-shared/work-checkpoint';
import { readBoundedFileNoFollow } from '../utils/readBoundedFile';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => { throw new Error(code); };

/** Immutable revisions: atomic create-next is the CAS, shared by concurrent host calls/processes. */
export function workRecordStore(root: string, sessionId: string, epoch: number, current: () => void) {
  if (!sessionId || !Number.isSafeInteger(epoch) || epoch < 0) fail('INVALID_WORK_RECORD_SCOPE');
  const directory = path.join(root, hash(sessionId), String(epoch));
  const file = (revision: number) => path.join(directory, `${revision}.json`);
  const revisions = async () => {
    current();
    let entries: string[];
    try { entries = await fs.readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    current();
    return entries.filter(name => /^[1-9]\d{0,15}\.json$/.test(name)).map(name => Number(name.slice(0, -5)))
      .filter(Number.isSafeInteger).sort((a, b) => b - a);
  };
  const read = async (revision: number): Promise<WorkCheckpointRecord> => {
    current();
    const bytes = await readBoundedFileNoFollow(file(revision), WORK_CHECKPOINT_MAX_BYTES + 16000,
      { containWithin: await fs.realpath(root), verifyContentStability: true, nonBlocking: true });
    if (!bytes) return fail('INVALID_WORK_RECORD');
    const record = JSON.parse(bytes.toString('utf8')) as WorkCheckpointRecord;
    if (record.version !== 1 || record.sessionId !== sessionId || record.epoch !== epoch || record.revision !== revision
      || !Number.isSafeInteger(record.savedAt) || record.author?.kind !== 'agent_report' || typeof record.author.agentKind !== 'string' || record.author.agentKind.length > 80
      || (record.author.sessionInstanceId !== undefined && (typeof record.author.sessionInstanceId !== 'string' || record.author.sessionInstanceId.length > 512))
      || !record.workspace || !['observed', 'unavailable'].includes(record.workspace.status)) return fail('INVALID_WORK_RECORD');
    const workspace = record.workspace;
    if (!Number.isSafeInteger(workspace.observedAt) || (workspace.status === 'unavailable'
      ? !['remote_workspace', 'missing_workdir', 'git_unavailable'].includes(workspace.reason)
      : typeof workspace.workingDir !== 'string' || workspace.workingDir.length > 8192 || typeof workspace.branch !== 'string' || workspace.branch.length > 8192
        || (workspace.head !== null && !/^[a-f0-9]{40,64}$/.test(workspace.head)) || typeof workspace.dirty !== 'boolean'
        || !Number.isSafeInteger(workspace.changedPathCount) || workspace.changedPathCount < 0 || !/^[a-f0-9]{64}$/.test(workspace.statusDigest))) return fail('INVALID_WORK_RECORD');
    record.checkpoint = parseWorkCheckpoint(record.checkpoint);
    if (record.inputHash !== hash(JSON.stringify(record.checkpoint))) return fail('INVALID_WORK_RECORD');
    current(); return record;
  };
  return {
    async latest() { const versions = await revisions(); return versions.length ? read(versions[0]) : null; },
    async at(revision: number) {
      if (!(await revisions()).includes(revision)) fail('WORK_RECORD_NOT_FOUND');
      return read(revision);
    },
    async list(before?: number, limit = 20) {
      const versions = (await revisions()).filter(revision => before === undefined || revision < before);
      const selected = versions.slice(0, Math.min(limit, 50));
      const records = [];
      for (const revision of selected) records.push(await read(revision));
      return { records, next_before: versions.length > selected.length ? selected.at(-1) : null };
    },
    async save(expectedRevision: number, value: WorkCheckpointData, author: WorkCheckpointRecord['author'], workspace: WorkspaceObservation): Promise<WorkCheckpointRecord> {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) fail('INVALID_WORK_RECORD_REVISION');
      const checkpoint = parseWorkCheckpoint(value), inputHash = hash(JSON.stringify(checkpoint)), next = expectedRevision + 1;
      const versions = await revisions();
      if (versions.length) await read(versions[0]);
      if (versions[0] !== expectedRevision && !(expectedRevision === 0 && !versions.length)) {
        // Lost acknowledgement: same base + same payload returns its immutable receipt, never another write.
        if (versions.includes(next)) { const previous = await read(next); if (previous.inputHash === inputHash) return previous; }
        return fail('WORK_RECORD_CONFLICT');
      }
      const record: WorkCheckpointRecord = { version: 1, sessionId, epoch, revision: next, savedAt: Date.now(), inputHash, author, checkpoint, workspace };
      const raw = JSON.stringify(record);
      if (Buffer.byteLength(raw) > WORK_CHECKPOINT_MAX_BYTES + 16000) fail('WORK_RECORD_TOO_LARGE');
      current(); await fs.mkdir(root, { recursive: true, mode: 0o700 });
      // Match the managed-Vault adapter: profile root may be redirected, children may not.
      for (const child of [path.dirname(directory), directory]) {
        await fs.mkdir(child, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
        const stat = await fs.lstat(child);
        if (!stat.isDirectory() || stat.isSymbolicLink()) fail('INVALID_WORK_RECORD_DIRECTORY');
      }
      const temporary = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
        current();
        try { await fs.link(temporary, file(next)); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const previous = await read(next);
          return previous.inputHash === inputHash ? previous : fail('WORK_RECORD_CONFLICT');
        }
        // POSIX directory flush makes the new immutable name durable as well as its bytes.
        // Windows does not expose directory fsync through Node; file sync + create-new still apply.
        if (process.platform !== 'win32') {
          const parent = await fs.open(directory, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
        }
        current(); return record;
      } finally { await fs.unlink(temporary).catch(() => undefined); }
    },
  };
}
