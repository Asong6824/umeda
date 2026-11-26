import { createHash } from 'node:crypto';
import type { WorkspaceObservation } from '@cindy/maker-shared/work-checkpoint';
import { runGit } from '../git-review/gitRunner';

export interface WorkSessionFacts { id: string; clearedAt: number | null; workingDir: string | null; remoteHostId: string | null; agentDeviceId: string | null }
/** Read only; no diff/file bytes, snapshot commit, Git configuration changes or remote path guesses. */
export async function observeWorkWorkspace(facts: WorkSessionFacts, run: typeof runGit = runGit): Promise<WorkspaceObservation> {
  const observedAt = Date.now();
  if (facts.remoteHostId || facts.agentDeviceId) return { status: 'unavailable', observedAt, reason: 'remote_workspace' };
  if (!facts.workingDir) return { status: 'unavailable', observedAt, reason: 'missing_workdir' };
  try {
    const { stdout } = await run(['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'],
      { cwd: facts.workingDir, timeoutMs: 4000, maxStdoutBytes: 512 * 1024,
        extraEnv: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined, GIT_INDEX_FILE: undefined, GIT_NO_LAZY_FETCH: '1' } });
    const entries = stdout.split('\0');
    const oid = entries.find(item => item.startsWith('# branch.oid '))?.slice(13);
    const branch = entries.find(item => item.startsWith('# branch.head '))?.slice(14);
    if (!oid || !branch || (oid !== '(initial)' && !/^[a-f0-9]{40,64}$/.test(oid))) throw new Error('INVALID_GIT_STATUS');
    let changedPathCount = 0;
    for (let index = 0; index < entries.length; index++) {
      if (/^[12u?] /.test(entries[index])) changedPathCount++;
      if (entries[index].startsWith('2 ')) index++; // rename's original path is a separate NUL record.
    }
    return { status: 'observed', observedAt, workingDir: facts.workingDir, head: oid === '(initial)' ? null : oid, branch,
      dirty: changedPathCount > 0, changedPathCount, statusDigest: createHash('sha256').update(stdout).digest('hex') };
  } catch { return { status: 'unavailable', observedAt, reason: 'git_unavailable' }; }
}
