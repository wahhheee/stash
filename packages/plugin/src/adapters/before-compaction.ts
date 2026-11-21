import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Context } from '@deepseek-ai/cordis';
import type { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import {
  BlockAssembler,
  createToolResultMessage,
  type RequestMessage,
  type Message,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm';
import {
  BEFORE_COMPACTION,
  COMPACTION_STAGE_TOOLS,
  commitFiles,
  StashError,
  toolError,
} from '@wahhheee/stash-core';
import { z } from 'zod';
import { CompactionCopy } from '../host/compaction-copy.ts';
import { validatePlan } from '../host/maintenance.ts';
import type { MemoryAdapter } from './memory-dsh.ts';
import { digest, snapshotRevision } from './memory-store.ts';
import { isMaintenance } from './maintenance-schema.ts';
import { appendCompactionBatch, validateCommit } from './session-memory.ts';
import { runStageTool } from './stage-tools.ts';

export type SummaryInput = {
  readonly messages: readonly Message[];
  readonly tools?: readonly ToolSchema[];
};

async function openCopy(
  adapter: MemoryAdapter,
  agent: Agent,
  workspaceEnabled: boolean,
  check: () => Promise<void>,
  active: () => void,
) {
  const workspace = workspaceEnabled ? await adapter.memory(agent) : undefined;
  const ws = workspace
    ? {
        files: await adapter.store.snapshot(workspace.workspaceId, true),
        aliases: await adapter.store.aliases(workspace.workspaceId),
      }
    : { files: new Map<string, string>(), aliases: new Map<string, string>() };
  const projection = await adapter.sessionProjection;
  const state = () => projection.stateOf(agent.session);
  const current = state();
  const local = {
    files: commitFiles(current),
    aliases: new Map(Object.entries(current.aliases ?? {})),
  };
  const copy = new CompactionCopy(
    [ws, local],
    adapter.meter,
    adapter.config.viewBudgetTokens,
    !!workspace,
  );
  const submit = async () => {
    await check();
    const [w, s] = copy.submission();
    if (w.changes.length) validatePlan(w.files, adapter.meter, adapter.config);
    if (s.changes.length) validatePlan(s.files, adapter.meter, adapter.config);
    const verify = () => {
      active();
      if (
        s.changes.length &&
        state() !== current &&
        (snapshotRevision(commitFiles(state())) !== snapshotRevision(local.files) ||
          JSON.stringify(state().aliases) !== JSON.stringify(current.aliases))
      )
        throw new StashError('STASH_STALE_READ', '会话记忆已变化');
    };
    const commits = s.changes.map((c) =>
      validateCommit({
        v: 1,
        id: randomUUID(),
        sessionId: agent.id,
        path: c.path,
        content: c.after,
        beforeRevision: c.before === null ? null : digest(c.before),
        revision: c.after === null ? null : digest(c.after),
      }),
    );
    verify();
    if (workspace && w.changes.length)
      await adapter.store.applyCompactionCopy(
        workspace.workspaceId,
        ws.files,
        ws.aliases,
        w.changes,
        verify,
      );
    if (commits.length) {
      await check();
      verify();
      appendCompactionBatch(
        agent.session,
        state(),
        commits,
        s.changes.flatMap((c) => (c.redirect ? [[c.path, c.redirect] as [string, string]] : [])),
      );
      await adapter.ctx.sessions.flush(agent.session);
    }
    return {
      changes: [...w.changes, ...s.changes],
      applied: !!(w.changes.length || s.changes.length),
    };
  };
  return { copy, submit };
}

export class CompactionNotes {
  constructor(
    private ctx: Context,
    private config: BasicCompactionEngine['config'],
    private memory: MemoryAdapter,
    private enabled: () => boolean,
  ) {}

  async summarize<T>(
    input: SummaryInput,
    agent: Agent,
    signal: AbortSignal | undefined,
    stock: () => Promise<T>,
  ): Promise<T> {
    try {
      if (
        this.enabled() &&
        !isMaintenance(agent.id) &&
        agent.session.header.origin !== 'subagent' &&
        input.tools?.some((t) => t.name === 'memory_write')
      )
        await this.prepare(this.memory, input, agent, signal);
    } catch {
      signal?.throwIfAborted();
      this.ctx.logger.warn('stash: 压缩前补记未完成，继续原版摘要');
    }
    signal?.throwIfAborted();
    return stock();
  }

  private async prepare(
    adapter: MemoryAdapter,
    input: SummaryInput,
    agent: Agent,
    signal?: AbortSignal,
  ) {
    const policy = await adapter.policy(agent),
      header = agent.session.requestHeader()?.config;
    if (!header || !policy.enabled || !policy.writable) return;
    const active = () => {
      signal?.throwIfAborted();
      if (!this.enabled()) throw new StashError('STASH_DISABLED', '补记已关闭');
    };
    const check = async () => {
      active();
      const now = await adapter.policy(agent);
      if (!now.enabled || !now.writable || now.inheritWorkspace !== policy.inheritWorkspace)
        throw new StashError('STASH_READ_ONLY', '写入权限已变化');
    };
    const override = this.config.modelPolicies.find(
      (p) => p.provider === header.provider && p.model === header.model,
    );
    const provider =
      (override?.summarizationProvider ?? this.config.summarizationProvider) || header.provider;
    const model = (override?.summarizationModel ?? this.config.summarizationModel) || header.model;
    const messages: RequestMessage[] = [
      ...input.messages,
      { role: 'user', content: [{ type: 'text', text: BEFORE_COMPACTION }] },
    ];
    let stage: Awaited<ReturnType<typeof openCopy>> | undefined;
    // 上限只防失控工具循环，不限制哪些素材相关。未提交的副本随本次调用释放。
    for (let round = 0; round < 48; round++) {
      await check();
      const a = new BlockAssembler();
      for await (const chunk of this.ctx.llm.stream({
        provider,
        model,
        maxTokens: override?.maxTokens ?? this.config.maxTokens,
        sessionId: agent.id,
        purpose: 'compaction',
        messages,
        tools: COMPACTION_STAGE_TOOLS,
        ...(signal ? { signal } : {}),
      }))
        a.push(chunk);
      signal?.throwIfAborted();
      if (['max-tokens', 'error', 'aborted'].includes(a.finish.kind)) return;
      const calls = a.blocks().filter((b) => b.type === 'tool-call');
      if (!calls.length) return;
      messages.push(a.message({ provider, model }));
      for (const call of calls) {
        await check();
        stage ??= await openCopy(adapter, agent, policy.inheritWorkspace, check, active);
        let text: string,
          isError = false;
        try {
          text = await runStageTool(
            stage.copy,
            call.name,
            JSON.parse(call.arguments),
            stage.submit,
          );
          if (call.name === 'stash_submit') return;
        } catch (e) {
          if (!(e instanceof StashError || e instanceof z.ZodError || e instanceof SyntaxError))
            throw e;
          if (e instanceof StashError && ['STASH_READ_ONLY', 'STASH_DISABLED'].includes(e.code))
            throw e;
          text = toolError(
            e instanceof StashError ? e.code : 'STASH_INVALID_DATA',
            e instanceof StashError ? e.detail : undefined,
          );
          isError = true;
        }
        messages.push(
          createToolResultMessage({ callId: call.id, content: [{ type: 'text', text }], isError }),
        );
      }
    }
  }
}
