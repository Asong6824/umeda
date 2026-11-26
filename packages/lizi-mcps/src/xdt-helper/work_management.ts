import { z } from 'zod';
import type { WorkManagementRequest } from '@cindy/maker-shared/work-management';
import type { LiziMcpSessionContext } from '../types.js';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import { errorPayload, okPayload } from './_payload.js';

export type WorkManagementCallback = (context: LiziMcpSessionContext, request: WorkManagementRequest) => Promise<Record<string, unknown>>;
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const ids = z.array(id).max(20);
const title = z.string().trim().min(1).max(300);
const description = z.string().max(8000);
const progress = z.strictObject({ percent: z.number().min(0).max(100), basis: z.string().trim().min(1).max(2000) }).nullable();

export function registerWorkManagementTools(registry: XdtHelperToolRegistry, current: () => LiziMcpSessionContext, execute: WorkManagementCallback) {
  const call = async (request: WorkManagementRequest) => {
    const context = current();
    if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', '请在宿主绑定的当前执行任务中调用。');
    try {
      const result = await execute(context, request);
      return result.ok === false ? errorPayload(String(result.errorCode ?? 'WORK_MANAGEMENT_UNAVAILABLE'), String(result.hint ?? '工作管理暂不可用。'), result) : okPayload(result);
    } catch {
      return errorPayload('WORK_MANAGEMENT_UNAVAILABLE', '操作结果未确认。写入请保留相同 request_id 与内容重试以取回原回执；不要换 ID 重复更新。');
    }
  };
  registry.register({ name: 'get_work_sync_status', category: 'work', inputShape: {},
    description: '主人询问多端进度或同步时，按需读取本机工作管理的待发送数量、最近云端联系时间与冲突摘要。不是触发完整上下文加载，不代表其他设备已读到；网络暂停时本机修改仍保留。', handler: () => call({ operation: 'sync_status' }) });
  registry.register({ name: 'get_work_sync_conflict', category: 'work', inputShape: { request_id: id },
    description: '按需读取一个工作同步冲突的本机当前内容、最新已收到的共享内容和原工作记录。只读取指定冲突，不递归读取其他对象、代码或 KOS。先比较后再向主人解释取舍。', handler: args => call({ ...args, operation: 'sync_conflict' }) });
  registry.register({ name: 'resolve_work_sync_conflict', category: 'work', inputShape: { request_id: id, choice: z.enum(['local', 'remote']) },
    description: '仅在主人明确选定保留哪份内容后处理指定同步冲突。local 把本机内容作为新操作重新排队；remote 使用共享版本并放弃相关的本机待发送修改及其后续关联修改，原回执保留。不要自行替主人选择覆盖；遇到创建冲突或范围过大保留草稿并说明原因。', handler: args => call({ ...args, operation: 'sync_resolve' }) });
  registry.register({ name: 'list_work_items', category: 'work', inputShape: {
    kind: z.enum(['goal', 'project', 'task']).optional(), query: z.string().max(200).optional(), project_id: id.optional(), goal_id: id.optional(), after: id.optional(), limit: z.number().int().min(1).max(50).optional(),
  }, description: '主人明确要求时，按需查找 Umeda 的业务目标、项目、任务（与执行 Session 不同）。各 Agent 共用当前宿主的同一份记录；返回有界摘要，不读取全部正文或 KOS。用名称 query 查找，按 next_after 翻页。不会因工具发现、打开项目或换引擎而自动加载；读取本机副本，云端增量在后台同步；要确认待发送修改与冲突，按需调用 get_work_sync_status。', handler: args => call({ ...args, operation: 'list' }) });
  registry.register({ name: 'get_work_item', category: 'work', inputShape: { id, before_record: z.number().int().positive().safe().optional() },
    description: '按主人请求读取一个业务对象、revision、直接关联 ID 和该对象最近工作记录。before_record 使用 next_before_record 读取更早记录；关联对象和 KOS 正文须按需另读，不递归装载。进度为有依据的人工／Agent 报告，不是宿主独立验证。', handler: args => call({ ...args, operation: 'get' }) });
  registry.register({ name: 'create_work_item', category: 'work', inputShape: { request_id: id, kind: z.enum(['goal', 'project', 'task']), title, description: description.optional(), project_ids: ids.optional(), goal_ids: ids.optional() },
    description: '按主人要求新建简单的目标、项目或业务任务，只有标题必需，无需先建立完整层级。request_id 为本次操作生成并在重试时保持不变；关系用已有对象 ID。目标／项目初始 doing，任务 todo；不修改旧 KOS Vault，不创建或启动执行 Session。本机保存，不表示其他设备已同步。', handler: args => call({ ...args, operation: 'create' }) });
  registry.register({ name: 'get_work_progress_record', category: 'work', inputShape: { request_id: id },
    description: '按需读取一份工作记录的完整 JSON，含本次变更前后、来源执行任务与引擎、验证自述和更新依据；用于核实历史或取回丢失回执。不会读取代码、原始工具日志或关联 KOS 正文。', handler: args => call({ ...args, operation: 'record' }) });
  registry.register({ name: 'update_work_progress', category: 'work', inputShape: {
    request_id: id, summary: z.string().trim().min(1).max(4000),
    changes: z.array(z.strictObject({ id, expected_revision: z.number().int().positive().safe(), title: title.optional(), description: description.optional(), status: z.enum(['todo', 'doing', 'done', 'blocked', 'cancelled']).optional(), project_ids: ids.optional(), goal_ids: ids.optional(), progress: progress.optional() })).min(1).max(20),
    verification: z.array(z.strictObject({ description: z.string().min(1).max(1000), outcome: z.enum(['reported_passed', 'reported_failed', 'not_run', 'unknown']), evidence: z.string().max(2000).optional() })).max(20).optional(),
  }, description: '主人明确要求更新进度时，把本次成果一次原子写入业务任务、项目记录和关联目标。先按需读取相关对象获得 revision；changes 仅填需要改的字段，其余保留。只写 id+expected_revision 可仅为项目／目标追加本次记录。共享 request_id 与内容重试不重复写；任一版本冲突整批不写，重读合并后用新 request_id。目标进度 progress.percent 必须带非空 basis 依据，无法判断则只记里程碑，不编百分比；任务 done 不自动把项目／目标设为 done。不把 Agent 自述标成宿主验证，不自动写 KOS、同步代码或结束执行 Session。', handler: args => call({ ...args, operation: 'update' }) });
}
