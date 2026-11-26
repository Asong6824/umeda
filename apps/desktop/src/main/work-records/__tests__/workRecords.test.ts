/**
 * Production: workRecordStore + observeWorkWorkspace + shared checkpoint parser/formatter.
 * Rule: Umeda architecture's durable checkpoints, ownership and reported/verified distinction.
 * Gap: existing handoff tests have no persisted structured work facts or CAS/restart coverage.
 * Minimal failure: two Agents update revision 0 concurrently, or retry after losing a receipt.
 * Tier: unit; isolated temporary files and injected Git runner, no processes/network/user profile.
 * Standalone duration: 1.32s locally (2026-11-22), including collection/setup.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseWorkCheckpoint, renderWorkCheckpoint, type WorkCheckpointData } from '@cindy/maker-shared/work-checkpoint';
import { workRecordStore } from '../store';
import { observeWorkWorkspace } from '../workspace';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
const data = (objective = 'Keep work independent of the engine'): WorkCheckpointData => ({ objective,
  acceptance: ['Can continue with another engine'], completed: ['Added tools'], decisions: ['Keep native runtime'], next: ['Verify handoff'], blockers: [],
  verification: [{ description: 'unit tests', outcome: 'reported_passed', evidence: 'test-run-1' }], references: [{ label: 'KOS source', ref: 'notes/architecture.md' }] });
const author = { kind: 'agent_report' as const, agentKind: 'codex' };
const workspace = { status: 'unavailable' as const, observedAt: 1, reason: 'remote_workspace' as const };
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'umeda-work-records-')); directories.push(root);
  return { root, store: workRecordStore(root, 'task', 0, () => {}) };
}

describe('work records', () => {
  it('persists revisions independently of engines and replays identical receipts without duplication', async () => {
    const { root, store } = await setup();
    expect(await store.latest()).toBeNull();
    const first = await store.save(0, data(), author, workspace);
    const restarted = workRecordStore(root, 'task', 0, () => {});
    expect(await restarted.latest()).toEqual(first);
    expect(await restarted.save(0, data(), { ...author, agentKind: 'claude-code' }, workspace)).toEqual(first);
    await restarted.save(1, data('Next milestone'), { ...author, agentKind: 'claude-code' }, workspace);
    const page = await store.list(undefined, 1);
    expect(page.records[0].revision).toBe(2); expect(page.next_before).toBe(2);
    expect((await store.list(2)).records[0]).toEqual(first);
    expect(await store.at(1)).toEqual(first);
    await expect(store.at(99)).rejects.toThrow('WORK_RECORD_NOT_FOUND');
    expect(await restarted.save(0, data(), author, workspace)).toEqual(first);
    await expect(store.save(0, data('stale edit'), author, workspace)).rejects.toThrow('WORK_RECORD_CONFLICT');
    expect(await workRecordStore(root, 'task', 100, () => {}).latest()).toBeNull(); // /clear starts a new epoch.
    expect(await workRecordStore(root, 'another-task', 0, () => {}).latest()).toBeNull();
  });

  it('does not overwrite a concurrent writer or commit after scope revocation', async () => {
    const { root, store } = await setup();
    const results = await Promise.allSettled([store.save(0, data('one'), author, workspace), store.save(0, data('two'), author, workspace)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await store.list()).records).toHaveLength(1);
    const revoked = workRecordStore(root, 'revoked', 0, () => { throw new Error('OWNER_CHANGED'); });
    await expect(revoked.save(0, data(), author, workspace)).rejects.toThrow('OWNER_CHANGED');
    expect(await workRecordStore(root, 'revoked', 0, () => {}).latest()).toBeNull();
  });

  it('rejects corrupt persisted content and never replaces it with an empty record', async () => {
    const { root, store } = await setup(); await store.save(0, data(), author, workspace);
    const task = (await fs.readdir(root))[0], file = path.join(root, task, '0', '1.json');
    const original = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...original, checkpoint: data('tampered') }));
    await expect(store.latest()).rejects.toThrow('INVALID_WORK_RECORD');
    await expect(store.save(0, data(), author, workspace)).rejects.toThrow('INVALID_WORK_RECORD');
    await expect(store.save(1, data('new report'), author, workspace)).rejects.toThrow('INVALID_WORK_RECORD');
    expect(() => parseWorkCheckpoint({ ...data(), verification: [{ description: 'claimed', outcome: 'host_verified' }] })).toThrow('INVALID_WORK_CHECKPOINT');
  });

  it('does not follow a redirected session directory to write outside its profile', async () => {
    const { root, store } = await setup(); await store.save(0, data(), author, workspace);
    const task = (await fs.readdir(root))[0], epoch = path.join(root, task, '0');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'umeda-work-outside-')); directories.push(outside);
    await fs.rm(epoch, { recursive: true }); await fs.symlink(outside, epoch, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(store.save(0, data(), author, workspace)).rejects.toThrow('INVALID_WORK_RECORD_DIRECTORY');
    expect(await fs.readdir(outside)).toEqual([]);
  });

  it('records only host-observed Git metadata and marks remote or failed inspection unavailable', async () => {
    const facts = { id: 'task', clearedAt: null, workingDir: '/fixture', remoteHostId: null, agentDeviceId: null };
    const run = vi.fn(async () => ({ stdout: [`# branch.oid ${'a'.repeat(40)}`, '# branch.head topic', '? private-name.md', '2 R. renamed', '? original-name', ''].join('\0'), stderr: '', exitCode: 0 }));
    const observed = await observeWorkWorkspace(facts, run);
    expect(observed).toMatchObject({ status: 'observed', head: 'a'.repeat(40), branch: 'topic', dirty: true, changedPathCount: 2 });
    expect(JSON.stringify(observed)).not.toContain('private-name');
    expect(await observeWorkWorkspace({ ...facts, remoteHostId: 'ssh' }, run)).toMatchObject({ status: 'unavailable', reason: 'remote_workspace' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(await observeWorkWorkspace(facts, vi.fn().mockRejectedValue(new Error('private error')))).toMatchObject({ status: 'unavailable', reason: 'git_unavailable' });
  });

  it('keeps handoff data bounded, parseable and explicit about reported verification', async () => {
    const { store } = await setup(); const record = await store.save(0, data(), author, workspace);
    const rendered = renderWorkCheckpoint(record, workspace), projected = JSON.parse(rendered);
    expect(projected.provenance).toBe('agent_report_not_host_verified');
    expect(projected.next).toEqual(['Verify handoff']);
    expect(rendered.length).toBeLessThanOrEqual(4000);
    const longPath = { status: 'observed' as const, observedAt: 1, workingDir: 'a'.repeat(10000), head: null, branch: 'topic', dirty: true, changedPathCount: 1, statusDigest: 'a'.repeat(64) };
    expect(JSON.parse(renderWorkCheckpoint(record, longPath))).toMatchObject({ revision: 1, next: ['Verify handoff'] });
  });
});
