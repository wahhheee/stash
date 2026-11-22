import type { Agent } from '@deepseek-ai/dsh-agent';
import { decideResident, foldResident, renderResident } from '@wahhheee/stash-core';
import { inspectMaintenance, validatePlan } from '../host/maintenance.ts';
import { runId } from './maintenance-schema.ts';
import { compactionRange, visibleRecords } from './resident-dsh.ts';
import type { MemoryAdapter } from './memory-dsh.ts';

export async function memoryCommand(
  adapter: MemoryAdapter,
  decisions: readonly string[],
  agent: Agent,
  raw: string,
): Promise<{ kind: 'success' | 'error'; text: string } | null> {
  const args = raw.trim().split(/\s+/u);
  if (args[0] === 'health' || args[0] === 'rollback') {
    if (
      args[0] === 'health'
        ? args.length !== 1
        : args.length !== 2 || !runId.safeParse(args[1]).success
    )
      return { kind: 'error', text: '用法：/stash health | /stash rollback <整理会话 ID>' };
    const memory = await adapter.memory(agent);
    if (args[0] === 'rollback') {
      await adapter.store.rollback(memory.workspaceId, args[1]!, (files) =>
        validatePlan(files, adapter.meter, adapter.config),
      );
      return { kind: 'success', text: '已回滚整理：' + args[1] };
    }
    const { health: h, runs } = await inspectMaintenance(
      adapter.store,
      memory.workspaceId,
      agent.session.header.cwd!,
      adapter.meter,
      adapter.config,
      () => adapter.ctx.workspaceRegistry.archivedSessionIds,
    );
    return {
      kind: 'success',
      text:
        `工作区笔记：${h.notes}；${h.unreadDays} 天未读：${h.unread}；上次整理后新增：${h.added}\n索引折叠：${h.folded}；规则预算：${h.rulesUsed}/${h.rulesLimit} tokens\n核实提交与 HEAD 不同：${h.verifiedDifferent}；无法比较：${h.verifiedUnknown}\n` +
        runs.map((r) => r.id + ' · ' + r.status).join('\n'),
    };
  }
  if (!['context', 'render', 'explain', 'status'].includes(args[0]!)) return null;
  if (args[0] === 'status') {
    if (args.length !== 1) return null;
    const memory = await adapter.memory(agent);
    const state = await adapter.actual(agent, await memory.actual());
    return {
      kind: 'success',
      text:
        '工作区：' +
        memory.workspaceId +
        '\n记忆目录：' +
        adapter.store.directory(memory.workspaceId) +
        '\n开关：' +
        JSON.stringify(await adapter.policy(agent)) +
        '\n规则：' +
        adapter.meter.estimate(state.rules) +
        '/' +
        adapter.config.rulesBudgetTokens +
        ' tokens\n索引：' +
        adapter.meter.estimate(state.index) +
        '/' +
        adapter.config.indexBudgetTokens +
        ' tokens；折叠：' +
        state.folded +
        '\n会话：' +
        agent.id +
        '\n会话规则：' +
        adapter.meter.estimate(state.session?.rules ?? '') +
        '/' +
        adapter.config.rulesBudgetTokens +
        ' tokens\n会话索引：' +
        adapter.meter.estimate(state.session?.index ?? '') +
        '/' +
        adapter.config.indexBudgetTokens +
        ' tokens\n可写：' +
        (!state.disabled && !state.policyReadOnly && !state.session?.readOnly),
    };
  }
  if (args[0] === 'explain') {
    if (args.length > 2 || (args[1] !== undefined && !/^(?:[1-9]\d?|100)$/u.test(args[1])))
      return { kind: 'error', text: '用法：/stash explain [1–100]' };
    return {
      kind: 'success',
      text: decisions.slice(-Number(args[1] ?? 10)).join('\n') || '当前进程暂无注入决策',
    };
  }
  if (args.length !== 1) return { kind: 'error', text: '用法：/stash context | render' };
  const memory = await adapter.memory(agent);
  const actual = await adapter.actual(agent, await memory.actual());
  const rendered = renderResident(memory.workspaceId, actual, compactionRange(agent));
  if (args[0] === 'render') return { kind: 'success', text: rendered };
  const believed = foldResident(visibleRecords(agent), memory.workspaceId);
  return {
    kind: 'success',
    text:
      '可见版本：\n' +
      (believed ? renderResident(memory.workspaceId, believed) : '无') +
      '\n实际版本（' +
      adapter.meter.estimate(rendered) +
      ' tokens）：\n' +
      rendered +
      '\n决策：' +
      JSON.stringify(
        decideResident(believed, actual, memory.workspaceId, adapter.meter, adapter.config),
      ),
  };
}
