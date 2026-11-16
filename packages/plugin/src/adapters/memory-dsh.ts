import { DshSwitchStore } from './switches.ts';
import { DEFAULT_SWITCHES, resolveSwitches } from '@wahhheee/stash-core';
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
  renderResident,
  sessionMemoryTarget,
  sessionWriteResult,
  expandRules,
} from '@wahhheee/stash-core';
import type { ResidentRecord, ResidentState, TokenEstimator } from '@wahhheee/stash-core';
import { WorkspaceMemory } from '../host/memory.ts';
import type { ResolvedConfig } from './config.ts';
import { FileMemoryStore, digest } from './memory-store.ts';
import type { FileTraceSink } from './trace.ts';

import { HistoryBrowser } from '../host/history.ts';
import { DshHistory, historyProjection } from './history-dsh.ts';
import { historyTarget } from '@wahhheee/stash-core';

import { residentSchema, eventResident } from './memory-records.ts';
import { sessionMemoryProjection, SessionMemoryStore, commitMessage } from './session-memory.ts';
import { parseWriteInput } from './write-input.ts';

const viewSchema = z
  .object({
    path: z.string(),
    cursor: z.string().optional(),
    query: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    detail: z.enum(['brief', 'full']).optional(),
    all: z.boolean().optional(),
  })
  .strict();

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
    const record = eventResident(event);
    if (record) records.push(record);
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
  readonly switches: DshSwitchStore;
  private readonly registrations = new WeakMap<Agent, () => Promise<void>>();
  private readonly admitted = new WeakSet<Agent>();
  private readonly initialEnabled = new WeakMap<Agent, boolean>();
  private readonly privacy = new WeakMap<Agent, string>();
  readonly history: Promise<DshHistory>;
  readonly sessionProjection;
  private readonly sessionMemories = new WeakMap<
    Agent,
    { store: SessionMemoryStore; memory: WorkspaceMemory }
  >();
  private readonly browsers = new WeakMap<Agent, HistoryBrowser>();
  private readonly memories = new WeakMap<Agent, Promise<WorkspaceMemory>>();
  private readonly parents = new WeakMap<Agent, { id: string; beforeSeq: number }>();
  private readonly decisions = new WeakMap<Agent, string[]>();
  readonly meter: TokenEstimator;

  constructor(
    readonly ctx: Context,
    readonly config: ResolvedConfig,
    readonly trace: FileTraceSink,
  ) {
    this.store = new FileMemoryStore(config.memoryRoot);
    this.switches = new DshSwitchStore(ctx, this.store, config.enabled);
    this.sessionProjection = ctx.sessionProjections.register(sessionMemoryProjection);
    this.history = ctx.sessionProjections
      .register(historyProjection)
      .then(async (handle) => new DshHistory(ctx, handle, await this.sessionProjection));
    ctx.effect(async () => {
      await this.history;
      return () => undefined;
    }, 'stash: history projection');
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
      if (decision.kind === 'reject' || (step === 1 && !decision.messages.length)) return decision;
      const policy = await this.policy(agent);
      await this.syncRegistration(agent, policy.enabled);
      if (!policy.enabled && !visibleRecords(agent).length) return decision;
      const memory = await this.memory(agent);
      const records = visibleRecords(agent);
      for (const message of decision.messages)
        if (message.source.kind === 'stash-memory')
          records.push(residentSchema.parse(message.source.stash));
      const session = await this.sessionMemory(agent);
      session.store.reset();
      const empty = { rules: '', index: '', folded: false };
      const observed =
        policy.enabled && policy.inheritWorkspace
          ? await memory.observe()
          : { state: empty, journalId: null };
      const actual = policy.enabled
        ? await this.actual(agent, observed.state)
        : { ...empty, disabled: true };
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
        decision: result.kind === 'rules' || result.kind === 'position' ? 'delta' : result.kind,
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
        sessionMemory: true,
        ...(this.parents.has(agent) ? { parent: this.parents.get(agent)! } : {}),
        readOnly: agent.session.header.origin === 'subagent' && !config.subagentWrite,
        disabled: !policy.enabled,
        clean: !policy.inheritWorkspace,
        policyReadOnly: !policy.writable,
      });
      if (result.kind === 'none') return decision;
      const stash: ResidentRecord = {
        v: 1,
        workspaceId: memory.workspaceId,
        kind: result.kind,
        state:
          result.kind === 'position' && believed
            ? { ...believed, session: actual.session! }
            : actual,
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

  async workspace(agent: Agent) {
    const registry = this.ctx.workspaceRegistry;
    const existing = registry.list().find((w) => w.sessionIds.includes(agent.id));
    if (existing) return existing;
    if (!agent.session.header.cwd) return null;
    const workspace = await registry.create(agent.session.header.cwd);
    await workspace.attachSession(agent.id);
    return workspace;
  }

  async policy(agent: Agent) {
    if (!this.config.enabled) return resolveSwitches(false);
    const workspace = await this.workspace(agent);
    return resolveSwitches(
      this.config.enabled,
      workspace
        ? ((await this.switches.get({ kind: 'workspace', id: workspace.id })) ?? DEFAULT_SWITCHES)
        : DEFAULT_SWITCHES,
      (await this.switches.get({ kind: 'session', id: agent.id })) ?? DEFAULT_SWITCHES,
    );
  }

  private async attach(agent: Agent): Promise<void> {
    await this.workspace(agent);
    if (
      agent.session.inheritedEventCount &&
      !(await this.switches.get({ kind: 'session', id: agent.id }))
    ) {
      const lineage = await (await this.history).lineage(agent.id, true);
      if (lineage?.source)
        await this.switches.set(
          { kind: 'session', id: agent.id },
          (await this.switches.get({ kind: 'session', id: lineage.source })) ?? DEFAULT_SWITCHES,
        );
      else if (lineage?.candidates.length) {
        const candidates = await Promise.all(
          lineage.candidates.map((id) => this.switches.get({ kind: 'session', id })),
        );
        if (candidates.some((record) => JSON.stringify(record) !== JSON.stringify(candidates[0])))
          throw new StashError('STASH_AMBIGUOUS_REF', '无法确定分叉开关来源');
        await this.switches.set(
          { kind: 'session', id: agent.id },
          candidates[0] ?? DEFAULT_SWITCHES,
        );
      }
    }
    await this.syncRegistration(agent, (await this.policy(agent)).enabled);
  }

  async syncRegistration(agent: Agent, enabled: boolean): Promise<void> {
    this.initialEnabled.set(agent, enabled);
    if (!this.registrations.has(agent)) await this.register(agent);
  }

  private async register(agent: Agent): Promise<void> {
    const steps = new WeakMap<object, Promise<boolean>>();
    const activation = {
      when: (context: object) => {
        let pending = steps.get(context);
        if (!pending) {
          pending = this.policy(agent).then((policy) => {
            if (policy.enabled) this.admitted.add(agent);
            return this.config.enabled && this.admitted.has(agent);
          });
          steps.set(context, pending);
        }
        return pending;
      },
    };
    const scoped = agent.ctx.plugin({
      apply: (scope) => {
        scope.on('tools/result', (exec, result) => {
          this.sessionMemories
            .get(agent)
            ?.store.settle(exec.callId, Boolean(result.isError), !exec.parent);
          return undefined;
        });
        scope.systemPrompt.section({
          name: 'stash',
          order: 100,
          text: ({ toolSet }) =>
            (toolSet ? toolSet.view(agent).has('memory_view') : this.initialEnabled.get(agent))
              ? INSTRUCTIONS
              : '',
        });
        scope.tools.register(
          {
            ...VIEW_TOOL,
            output: {
              schema: { type: 'string' },
              render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            execute: async (args, exec) =>
              this.boundary(async () => {
                if (!(await this.policy(agent)).enabled)
                  throw new StashError('STASH_DISABLED', '记忆已关闭');
                const input = viewSchema.parse(args);
                const memory = await this.memory(agent);
                const target = sessionMemoryTarget(input.path, agent.id);
                if (target?.writable) {
                  if (
                    input.query !== undefined ||
                    input.since !== undefined ||
                    input.until !== undefined ||
                    input.detail !== undefined ||
                    input.all !== undefined
                  )
                    throw new StashError('STASH_UNSUPPORTED', '这些选项只用于历史路径', {
                      kind: 'history-options',
                    });
                  const session = await this.sessionMemory(agent);
                  session.store.begin(exec.rootCallId);
                  return session.memory.view(target.path, input.cursor, input.path);
                }
                if (target || historyTarget(input.path, agent.id)) {
                  const domain = await this.switches.ready;
                  const privacy = JSON.stringify([...domain.table('sessions').entries()]);
                  let browser = this.browsers.get(agent);
                  if (this.privacy.get(agent) !== privacy) {
                    browser?.clearPages();
                    this.privacy.set(agent, privacy);
                  }
                  if (!browser) {
                    browser = new HistoryBrowser(
                      await this.history,
                      memory.workspaceId,
                      agent.id,
                      this.meter,
                      this.config.viewBudgetTokens,
                      {
                        discoverable: (id, current) =>
                          id === current ||
                          (domain.table('sessions').get(id)?.discoverable ?? true),
                      },
                    );
                    this.browsers.set(agent, browser);
                  }
                  return browser.view(input);
                }
                if (
                  input.query !== undefined ||
                  input.since !== undefined ||
                  input.until !== undefined ||
                  input.detail !== undefined ||
                  input.all !== undefined
                )
                  throw new StashError('STASH_UNSUPPORTED', '这些选项只用于历史路径', {
                    kind: 'history-options',
                  });
                return memory.view(input.path, input.cursor);
              }),
          },
          activation,
        );
        scope.tools.register(
          {
            ...WRITE_TOOL,
            output: {
              schema: {
                type: 'object',
                properties: {
                  text: { type: 'string' },
                  stash: { type: 'object', additionalProperties: true },
                  stashCommit: { type: 'object', additionalProperties: true },
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
                const policy = await this.policy(agent);
                if (!policy.enabled) throw new StashError('STASH_DISABLED', '记忆已关闭');
                if (!policy.writable)
                  throw new StashError('STASH_READ_ONLY', '记忆只读', {
                    kind: 'read-only',
                    reason: 'policy',
                  });
                if (agent.session.header.origin === 'subagent' && !this.config.subagentWrite)
                  throw new StashError('STASH_READ_ONLY', '子代理只读', {
                    kind: 'read-only',
                    reason: 'subagent',
                  });
                const input = parseWriteInput(args);
                const memory = await this.memory(agent);
                const believed = foldResident(visibleRecords(agent), memory.workspaceId);
                const target = sessionMemoryTarget(input.path, agent.id);
                if (target && !target.writable)
                  throw new StashError('STASH_READ_ONLY', '其他会话只读', {
                    kind: 'read-only',
                    reason: 'sibling',
                  });
                if (!target && historyTarget(input.path, agent.id))
                  throw new StashError('STASH_READ_ONLY', '历史记录只读', {
                    kind: 'read-only',
                    reason: 'history',
                  });
                const session = await this.sessionMemory(agent);
                session.store.begin(exec.rootCallId);
                const result = target
                  ? await session.memory.write(
                      { ...input, path: target.path },
                      exec.callId,
                      believed?.session?.rules ?? null,
                    )
                  : await memory.write(input, exec.callId, believed?.rules ?? null);
                const text = target
                  ? sessionWriteResult(result.text, target.path, input.op)
                  : result.text;
                const state = target
                  ? await this.actual(agent, await memory.actual())
                  : await this.actual(agent, result.state);
                const stash: ResidentRecord = {
                  v: 1,
                  workspaceId: memory.workspaceId,
                  kind: 'write',
                  scope: target ? 'session' : 'workspace',
                  state,
                  // 嵌套调用的参数未必进入模型可见结果，按保守补发处理。
                  trusted: result.trusted && !exec.parent,
                };
                const commit = target ? session.store.lastCommit() : undefined;
                if (exec.parent && commit) exec.deferContext(commitMessage(commit, text));
                if (exec.parent && !commit)
                  exec.deferContext(
                    createUserMessage({
                      content: [{ type: 'text', text }],
                      source: { kind: 'stash-memory', form: 'instructions', stash },
                    }),
                  );
                return { text, stash, ...(commit ? { stashCommit: commit } : {}) };
              }),
          },
          activation,
        );
      },
    });
    this.ctx.effect(() => () => scoped.dispose(), 'stash: agent memory');
    await scoped;
    this.registrations.set(agent, () => scoped.dispose());
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
        toolError(code, error instanceof StashError ? error.detail : undefined),
        code,
      );
    }
  }

  async memory(agent: Agent): Promise<WorkspaceMemory> {
    let pending = this.memories.get(agent);
    if (!pending) {
      pending = (async () => {
        const registry = this.ctx.get('workspaceRegistry');
        if (!registry)
          throw new StashError('STASH_IO_ERROR', '宿主缺少 workspaceRegistry', {
            kind: 'workspace-unavailable',
            reason: 'registry',
          });
        const cwd = agent.session.header.cwd;
        if (!cwd)
          throw new StashError('STASH_IO_ERROR', '会话没有工作目录', {
            kind: 'workspace-unavailable',
            reason: 'cwd',
          });
        const workspace =
          registry.list().find((w) => w.sessionIds.includes(agent.id)) ??
          (await registry.create(cwd));
        await workspace.attachSession(agent.id);
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

  async sessionMemory(agent: Agent) {
    let value = this.sessionMemories.get(agent);
    if (!value) {
      const projection = await this.sessionProjection;
      const store = new SessionMemoryStore(agent.session, () => projection.stateOf(agent.session));
      value = {
        store,
        memory: new WorkspaceMemory(store, agent.id, agent.id, this.meter, this.config, '.'),
      };
      this.sessionMemories.set(agent, value);
    }
    return value;
  }

  async actual(agent: Agent, workspace: ResidentState): Promise<ResidentState> {
    const policy = await this.policy(agent);
    if (!policy.enabled) return { rules: '', index: '', folded: false, disabled: true };
    const session = await this.sessionMemory(agent);
    const state = await session.memory.actual();
    let parentRules: string | undefined;
    if (agent.session.header.origin === 'subagent' && agent.session.header.parentSession) {
      const id = agent.session.header.parentSession;
      const parent = await (await this.history).memorySnapshot(id);
      parentRules = expandRules(parent.files);
      this.parents.set(agent, { id, beforeSeq: parent.beforeSeq });
    }
    return {
      ...(policy.inheritWorkspace ? workspace : { rules: '', index: '', folded: false }),
      ...(!policy.inheritWorkspace ? { clean: true } : {}),
      ...(!policy.writable ? { policyReadOnly: true } : {}),
      session: {
        ...state,
        id: agent.id,
        ...(parentRules === undefined ? {} : { parentRules }),
        readOnly: agent.session.header.origin === 'subagent' && !this.config.subagentWrite,
      },
    };
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
      const state = await this.actual(agent, await memory.actual());
      return {
        kind: 'success',
        text:
          '工作区：' +
          memory.workspaceId +
          '\n记忆目录：' +
          this.store.directory(memory.workspaceId) +
          '\n开关：' +
          JSON.stringify(await this.policy(agent)) +
          '\n规则：' +
          this.meter.estimate(state.rules) +
          '/' +
          this.config.rulesBudgetTokens +
          ' tokens\n索引：' +
          this.meter.estimate(state.index) +
          '/' +
          this.config.indexBudgetTokens +
          ' tokens；折叠：' +
          state.folded +
          '\n会话：' +
          agent.id +
          '\n会话规则：' +
          this.meter.estimate(state.session?.rules ?? '') +
          '/' +
          this.config.rulesBudgetTokens +
          ' tokens\n会话索引：' +
          this.meter.estimate(state.session?.index ?? '') +
          '/' +
          this.config.indexBudgetTokens +
          ' tokens\n可写：' +
          (!state.disabled && !state.policyReadOnly && !state.session?.readOnly),
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
    const actual = await this.actual(agent, await memory.actual());
    const rendered = renderResident(memory.workspaceId, actual, compactionRange(agent));
    if (args[0] === 'render') return { kind: 'success', text: rendered };
    const believed = foldResident(visibleRecords(agent), memory.workspaceId);
    return {
      kind: 'success',
      text:
        '可见版本：\n' +
        (believed ? renderResident(memory.workspaceId, believed) : '无') +
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
