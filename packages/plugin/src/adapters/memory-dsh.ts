import { memoryPolicy } from '../host/policy.ts';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-tools';
import type {} from '@deepseek-ai/dsh-token-meter';
import type {} from '@deepseek-ai/dsh-workspace';
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import {
  INSTRUCTIONS,
  VIEW_TOOL,
  WRITE_TOOL,
  StashError,
  toolError,
  foldResident,
  decideResident,
  fullContext,
} from '@wahhheee/stash-core';
import type { ResidentRecord, TokenEstimator } from '@wahhheee/stash-core';
import { WorkspaceMemory } from '../host/memory.ts';
import type { ResolvedConfig } from './config.ts';
import { FileMemoryStore, digest } from './memory-store.ts';
import type { FileTraceSink } from './trace.ts';

import { residentSchema } from './memory-records.ts';

const viewSchema = z.object({ path: z.string(), cursor: z.string().optional() }).strict();

const writeSchema = z
  .object({
    path: z.string(),
    op: z.enum(['create', 'append', 'edit', 'replace', 'archive', 'delete']),
    content: z.string().optional(),
    old: z.string().optional(),
    new: z.string().optional(),
  })
  .strict()
  .refine((x) =>
    ['create', 'append', 'replace'].includes(x.op)
      ? x.content !== undefined && x.old === undefined && x.new === undefined
      : x.op === 'edit'
        ? x.old !== undefined && x.new !== undefined && x.content === undefined
        : x.content === undefined && x.old === undefined && x.new === undefined,
  );

export interface MemorySource {
  kind: 'stash-memory';
  form: 'instructions';
  stash: ResidentRecord;
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'stash-memory': MemorySource;
  }
}

export function visibleRecords(agent: Agent): ResidentRecord[] {
  const records: ResidentRecord[] = [];
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq);
    let value: unknown;
    if (event?.type === 'user/message' && event.data.source.kind === 'stash-memory')
      value = event.data.source.stash;
    if (
      event?.type === 'tool/result' &&
      !event.data.message.isError &&
      event.data.meta &&
      typeof event.data.meta === 'object' &&
      'stash' in event.data.meta
    )
      value = event.data.meta.stash;
    if (value !== undefined) records.push(residentSchema.parse(value));
  }
  return records;
}

function compactionRange(agent: Agent): string | undefined {
  const seqs = agent.session.surface.nodes.flatMap((seq) => {
    const event = agent.session.eventAt(seq);
    return event?.type === 'user/message' && isCompactCheckpointSource(event.data.source)
      ? (event.sourceEventSeqs ?? [])
      : [];
  });
  return seqs.length ? Math.min(...seqs) + '..' + Math.max(...seqs) : undefined;
}

/** 生命周期、宿主协议与领域用例之间的边界。 */
export class MemoryAdapter {
  readonly store: FileMemoryStore;
  private readonly memories = new WeakMap<Agent, Promise<WorkspaceMemory>>();
  private readonly decisions = new WeakMap<Agent, string[]>();
  private readonly meter: TokenEstimator;

  constructor(
    readonly ctx: Context,
    readonly config: ResolvedConfig,
    readonly trace: FileTraceSink,
  ) {
    this.store = new FileMemoryStore(config.memoryRoot);
    this.meter = {
      estimate: (text) =>
        text
          ? ctx.tokenMeter.estimateMessage(
              createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
            ) -
            ctx.tokenMeter.estimateMessage(
              createUserMessage({
                content: [{ type: 'text', text: '' }],
                source: { kind: 'user' },
              }),
            )
          : 0,
    };
    ctx.on('agent/created', async ({ agent }) => {
      await this.attach(agent);
    });
    ctx.effect(async () => {
      for (const agent of ctx.agents.list()) await this.attach(agent);
      return () => undefined;
    }, 'stash: existing agents');
    ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
      const decision = await next();
      if (!memoryPolicy.enabled()) return decision;
      if (decision.kind === 'reject' || (step === 1 && !decision.messages.length)) return decision;
      const memory = await this.memory(agent);
      const records = visibleRecords(agent);
      for (const message of decision.messages)
        if (message.source.kind === 'stash-memory')
          records.push(residentSchema.parse(message.source.stash));
      const observed = await memory.observe();
      const actual = observed.state;
      const believed = foldResident(records, memory.workspaceId);
      const result = decideResident(
        believed,
        actual,
        memory.workspaceId,
        this.meter,
        config,
        compactionRange(agent),
      );
      const history = this.decisions.get(agent) ?? [];
      history.push(
        JSON.stringify({
          seq: agent.session.surface.nodes.at(-1),
          kind: result.kind,
          reason: result.reason,
          rulesHash: digest(actual.rules),
          indexHash: digest(actual.index),
        }),
      );
      this.decisions.set(agent, history.slice(-100));
      await trace.emit({
        v: 1,
        timestamp: new Date().toISOString(),
        kind: 'inject.decide',
        sessionId: agent.id,
        decision: result.kind === 'rules' ? 'delta' : result.kind,
        code: result.reason,
        hash: digest(actual.rules),
        tokens: this.meter.estimate(result.text),
      });
      signal.throwIfAborted();
      await this.store.audit(memory.workspaceId, agent.id, {
        v: 1,
        sessionId: agent.id,
        beforeSeq: agent.session.snapshotEvents().length,
        journalId: observed.journalId,
        config: {
          rulesBudgetTokens: config.rulesBudgetTokens,
          indexBudgetTokens: config.indexBudgetTokens,
          viewBudgetTokens: config.viewBudgetTokens,
          externalRuleUpdates: config.externalRuleUpdates,
        },
        kind: result.kind,
        reason: result.reason,
        textHash: digest(result.text),
        compacted: compactionRange(agent) ?? null,
      });
      if (result.kind === 'none') return decision;
      const stash: ResidentRecord = {
        v: 1,
        workspaceId: memory.workspaceId,
        kind: result.kind,
        state: actual,
      };
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: result.text }],
            source: { kind: 'stash-memory', form: 'instructions', stash },
          }),
        ],
      };
    });
  }

  private async attach(agent: Agent): Promise<void> {
    const scoped = agent.ctx.plugin({
      apply: (scope) => {
        scope.systemPrompt.section({ name: 'stash', order: 100, text: INSTRUCTIONS });
        scope.tools.register({
          ...VIEW_TOOL,
          output: {
            schema: { type: 'string' },
            render: (_args, value) => [{ type: 'text', text: String(value) }],
          },
          execute: async (args) =>
            this.boundary(async () => {
              const input = viewSchema.parse(args);
              return (await this.memory(agent)).view(input.path, input.cursor);
            }),
        });
        scope.tools.register({
          ...WRITE_TOOL,
          output: {
            schema: {
              type: 'object',
              properties: {
                text: { type: 'string' },
                stash: { type: 'object', additionalProperties: true },
              },
              required: ['text', 'stash'],
              additionalProperties: false,
            },
            render: (_args, value) => [
              { type: 'text', text: z.object({ text: z.string() }).parse(value).text },
            ],
            presentationMeta: (_args, value) => value,
          },
          execute: async (args, exec) =>
            this.boundary(async () => {
              exec.signal.throwIfAborted();
              if (!memoryPolicy.writable(agent.session.header.origin === 'subagent'))
                throw new StashError('STASH_UNSUPPORTED', '子代理只读');
              const input = writeSchema.parse(args);
              const memory = await this.memory(agent);
              const believed = foldResident(visibleRecords(agent), memory.workspaceId);
              const result = await memory.write(input, exec.rootCallId, believed?.rules ?? null);
              const stash: ResidentRecord = {
                v: 1,
                workspaceId: memory.workspaceId,
                kind: 'write',
                state: result.state,
                // 嵌套调用的参数未必进入模型可见结果，按保守补发处理。
                trusted: result.trusted && !exec.parent,
              };
              if (exec.parent)
                exec.deferContext(
                  createUserMessage({
                    content: [{ type: 'text', text: result.text }],
                    source: { kind: 'stash-memory', form: 'instructions', stash },
                  }),
                );
              return { text: result.text, stash };
            }),
        });
      },
    });
    this.ctx.effect(() => () => scoped.dispose(), 'stash: agent memory');
    await scoped;
  }

  private async boundary<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const code =
        error instanceof StashError
          ? error.code
          : error instanceof z.ZodError
            ? 'STASH_INVALID_DATA'
            : 'STASH_IO_ERROR';
      throw new HarnessError(
        toolError(
          code,
          error instanceof StashError && error.code === 'STASH_BUDGET_EXCEEDED'
            ? error.message
            : undefined,
        ),
        code,
      );
    }
  }

  async memory(agent: Agent): Promise<WorkspaceMemory> {
    let pending = this.memories.get(agent);
    if (!pending) {
      pending = (async () => {
        const registry = this.ctx.get('workspaceRegistry');
        if (!registry) throw new StashError('STASH_UNSUPPORTED', '宿主缺少 workspaceRegistry');
        const cwd = agent.session.header.cwd;
        if (!cwd) throw new StashError('STASH_UNSUPPORTED', '会话没有工作目录');
        const workspace =
          registry.list().find((w) => w.sessionIds.includes(agent.id)) ??
          (await registry.create(cwd));
        await this.store.ensure({
          format: 1,
          id: workspace.id,
          path: workspace.path,
          title: workspace.title,
        });
        return new WorkspaceMemory(this.store, workspace.id, agent.id, this.meter, this.config);
      })();
      this.memories.set(agent, pending);
      pending.catch(() => this.memories.delete(agent));
    }
    return pending;
  }

  async command(
    agent: Agent,
    raw: string,
  ): Promise<{ kind: 'success' | 'error'; text: string } | null> {
    const args = raw.trim().split(/\s+/u);
    if (!['context', 'render', 'explain', 'status'].includes(args[0]!)) return null;
    if (args[0] === 'status') {
      if (args.length !== 1) return null;
      const memory = await this.memory(agent);
      const state = await memory.actual();
      return {
        kind: 'success',
        text:
          '工作区：' +
          memory.workspaceId +
          '\n记忆目录：' +
          this.store.directory(memory.workspaceId) +
          '\n开关：开（阶段二固定策略）\n规则：' +
          this.meter.estimate(state.rules) +
          '/' +
          this.config.rulesBudgetTokens +
          ' tokens\n索引：' +
          this.meter.estimate(state.index) +
          '/' +
          this.config.indexBudgetTokens +
          ' tokens；折叠：' +
          state.folded,
      };
    }
    if (args[0] === 'explain') {
      if (args.length > 2 || (args[1] !== undefined && !/^(?:[1-9]\d?|100)$/u.test(args[1])))
        return { kind: 'error', text: '用法：/stash explain [1–100]' };
      return {
        kind: 'success',
        text:
          (this.decisions.get(agent) ?? []).slice(-Number(args[1] ?? 10)).join('\n') ||
          '当前进程暂无注入决策',
      };
    }
    if (args.length !== 1) return { kind: 'error', text: '用法：/stash context | render' };
    const memory = await this.memory(agent);
    const actual = await memory.actual();
    const rendered = fullContext(
      memory.workspaceId,
      actual.rules,
      actual.index,
      actual.folded,
      compactionRange(agent),
    );
    if (args[0] === 'render') return { kind: 'success', text: rendered };
    const believed = foldResident(visibleRecords(agent), memory.workspaceId);
    return {
      kind: 'success',
      text:
        '可见版本：\n' +
        (believed
          ? fullContext(memory.workspaceId, believed.rules, believed.index, believed.folded)
          : '无') +
        '\n实际版本（' +
        this.meter.estimate(rendered) +
        ' tokens）：\n' +
        rendered +
        '\n决策：' +
        JSON.stringify(
          decideResident(believed, actual, memory.workspaceId, this.meter, this.config),
        ),
    };
  }
}
