import { z } from 'zod';
import { WORK_CHECKPOINT_LIST_LIMIT, WORK_CHECKPOINT_TEXT_LIMIT, type WorkCheckpointData } from '@cindy/maker-shared/work-checkpoint';
import type { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry.js';
import type { LiziMcpSessionContext } from '../types.js';
import { errorPayload, okPayload } from './_payload.js';

export type WorkRecordRequest = { operation: 'get'; revision?: number } | { operation: 'list'; before?: number; limit?: number }
  | { operation: 'save'; expected_revision: number; checkpoint: WorkCheckpointData };
export type WorkRecordsCallback = (context: LiziMcpSessionContext, request: WorkRecordRequest) => Promise<Record<string, unknown>>;
const text = z.string().max(WORK_CHECKPOINT_TEXT_LIMIT);
const list = z.array(text).max(WORK_CHECKPOINT_LIST_LIMIT);
const checkpoint = z.strictObject({
  objective: text.min(1), acceptance: list, completed: list, decisions: list, next: list, blockers: list,
  verification: z.array(z.strictObject({ description: text, outcome: z.enum(['reported_passed', 'reported_failed', 'not_run', 'unknown']), evidence: text.optional() })).max(WORK_CHECKPOINT_LIST_LIMIT),
  references: z.array(z.strictObject({ label: text, ref: text })).max(WORK_CHECKPOINT_LIST_LIMIT),
});

export function registerWorkRecordTools(registry: XdtHelperToolRegistry, current: () => LiziMcpSessionContext, execute: WorkRecordsCallback) {
  const call = async (request: WorkRecordRequest) => {
    const context = current();
    if (!context.sessionId) return errorPayload('NO_SESSION_CONTEXT', '请在宿主绑定的当前任务中调用。');
    try {
      const result = await execute(context, request);
      return result.ok === false ? errorPayload(String(result.errorCode ?? 'WORK_RECORD_UNAVAILABLE'), String(result.hint ?? '工作记录暂不可用。'), result) : okPayload(result);
    } catch {
      return errorPayload(request.operation === 'save' ? 'WORK_RECORD_SAVE_UNCERTAIN' : 'WORK_RECORD_UNAVAILABLE',
        request.operation === 'save' ? '保存结果未确认。先读取当前检查点；相同 expected_revision 和内容可取回原回执，不要换版本盲目重写。' : '工作记录暂不可用，请保留现有上下文并检查任务状态。');
    }
  };
  registry.register({ name: 'get_work_checkpoint', category: 'work', inputShape: { revision: z.number().int().positive().safe().optional() },
    description: '读取当前 Umeda 任务的结构化工作检查点（仅本机宿主），返回 revision 与 record，含目标、验收条件、已完成、决定、待办、阻塞、验证自述及保存时宿主 Git 元数据。省略 revision 读最新，传版本可读历史完整内容。任务 ID 独立于引擎；继续前核实真实文件。无记录返回 record=null、revision=0。清空对话后的新代次不读取旧检查点。',
    handler: args => call({ ...args, operation: 'get' }) });
  registry.register({ name: 'save_work_checkpoint', category: 'work',
    inputShape: { expected_revision: z.number().int().nonnegative().safe(), checkpoint },
    description: '保存当前任务工作检查点，为更换 Codex／Claude Code／Pi 后续做提供应用级记录。先 get_work_checkpoint 获取 revision，再完整提交；空数组表示明确无此项。验证结果为 Agent 自述，不得标成宿主已验证；宿主另记实际 Git 元数据。版本冲突先重读合并，相同版本和内容重试不会重复新增。不会完成任务、启动 Agent、同步代码或自动写入 KOS；本机保存不表示其他设备已收到。不要写密钥、原始日志或整份代码。',
    handler: args => call({ ...args, operation: 'save' }) });
  registry.register({ name: 'list_work_records', category: 'work',
    inputShape: { before: z.number().int().positive().safe().optional(), limit: z.number().int().min(1).max(50).optional() },
    description: '按版本倒序分页查看当前任务的工作检查点修订摘要（仅本机、当前清空代次）。before 传 next_before；摘要是 Agent 保存的工作说明，不是完整运行审计或执行完成证明。',
    handler: args => call({ ...args, operation: 'list' }) });
}
