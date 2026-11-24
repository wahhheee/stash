import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-system-prompt';
import type {} from '@deepseek-ai/dsh-token-meter';
import type {} from '@deepseek-ai/dsh-workspace';
import {
  DEFAULT_SWITCHES,
  resolveSwitches,
  INSTRUCTIONS,
  MAINTENANCE_GUIDE,
  StashError,
  expandRules,
  type ResidentState,
  type TokenEstimator,
} from '@wahhheee/stash-core';
import { WorkspaceMemory } from '../host/memory.ts';
import type { ResolvedConfig } from './config.ts';
import { DshHistory, historyProjection } from './history-dsh.ts';
import { isMaintenance } from './maintenance-schema.ts';
import { memoryCommand } from './memory-command.ts';
import { registerMemoryTools, registerStageTools } from './memory-tools.ts';
import { FileMemoryStore } from './memory-store.ts';
import { watchResident } from './resident-dsh.ts';
import { sessionMemoryProjection, SessionMemoryStore } from './session-memory.ts';
import { DshSwitchStore } from './switches.ts';
import type { FileTraceSink } from './trace.ts';

/** 生命周期、宿主协议与领域用例之间的边界。 */
export class MemoryAdapter {
  readonly store: FileMemoryStore;
  readonly switches: DshSwitchStore;
  private readonly registrations = new WeakMap<Agent, Promise<void>>();
  private readonly admitted = new WeakSet<Agent>();
  private readonly initialEnabled = new WeakMap<Agent, boolean>();
  readonly history: Promise<DshHistory>;
  readonly sessionProjection;
  private readonly sessionMemories = new WeakMap<
    Agent,
    { store: SessionMemoryStore; memory: WorkspaceMemory }
  >();
  private readonly memories = new WeakMap<Agent, Promise<WorkspaceMemory>>();
  private readonly decisions: ReturnType<typeof watchResident>;
  readonly meter: TokenEstimator;

  requireActivePlan(group: string) {
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(group)))
      throw new StashError('STASH_READ_ONLY', '整理会话已归档');
  }

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
    this.decisions = watchResident(this);
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
    let pending = this.registrations.get(agent);
    if (!pending) {
      pending = this.register(agent).catch((error: unknown) => {
        this.registrations.delete(agent);
        throw error;
      });
      this.registrations.set(agent, pending);
    }
    await pending;
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
        const planner = isMaintenance(agent.id);
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
              ? planner
                ? MAINTENANCE_GUIDE
                : INSTRUCTIONS
              : '',
        });
        if (planner) registerStageTools(scope, agent, this, activation);
        else registerMemoryTools(scope, agent, this, activation);
      },
    });
    this.ctx.effect(() => () => scoped.dispose(), 'stash: agent memory');
    await scoped;
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
    const projection = await this.sessionProjection;
    let value = this.sessionMemories.get(agent);
    if (!value) {
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

  command(agent: Agent, raw: string) {
    return memoryCommand(this, this.decisions(agent), agent, raw);
  }
}
