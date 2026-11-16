import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  DEFAULT_SWITCHES,
  resolveSwitches,
  StashError,
  promoteNote,
  memoryPath,
} from '@wahhheee/stash-core';
import { commitMessage } from './session-memory.ts';
import { digest, snapshotRevision } from './memory-store.ts';
import { WorkspaceMemory } from '../host/memory.ts';
import type { MemoryAdapter } from './memory-dsh.ts';
import type { PageTarget, PageAction, MemoryPageData } from '../page-types.ts';

/** Remote 只操作用户指定的范围；会话提交占用宿主维护时段，防止和工具写入交错。 */
export class MemoryPage {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly adapter: MemoryAdapter) {}

  private async withTarget<T>(
    target: PageTarget,
    run: (workspaceId: string, agent: Agent | null) => Promise<T>,
  ): Promise<T> {
    const key = target.kind + ':' + target.id;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(() => this.openTarget(target, run));
    this.queues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.queues.get(key) === pending) this.queues.delete(key);
    }
  }

  private async openTarget<T>(
    target: PageTarget,
    run: (workspaceId: string, agent: Agent | null) => Promise<T>,
  ): Promise<T> {
    if (target.kind === 'workspace') {
      const workspace = this.adapter.ctx.workspaceRegistry.list().find((w) => w.id === target.id);
      if (!workspace) throw new StashError('STASH_NOT_FOUND', '工作区不存在');
      await this.adapter.store.ensure({
        format: 1,
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
      });
      return run(workspace.id, null);
    }
    const id = SessionId(target.id);
    const active = this.adapter.ctx.agents.get(id);
    const handle = active ? null : await this.adapter.ctx.agents.resume({ resumeSessionId: id });
    const agent = active ?? handle!.agent;
    try {
      const memory = await this.adapter.memory(agent);
      return await run(memory.workspaceId, agent);
    } finally {
      await handle?.dispose();
    }
  }

  async read(target: PageTarget): Promise<MemoryPageData> {
    if (target.kind === 'workspace')
      return this.withTarget(target, (id, agent) => this.data(id, agent));
    const workspace = this.adapter.ctx.workspaceRegistry
      .list()
      .find((w) => w.sessionIds.includes(SessionId(target.id)));
    if (!workspace) throw new StashError('STASH_NOT_FOUND', '会话尚未关联工作区');
    await this.adapter.store.ensure({
      format: 1,
      id: workspace.id,
      path: workspace.path,
      title: workspace.title,
    });
    return this.data(workspace.id, null, target.id);
  }

  private async data(
    id: string,
    agent: Agent | null,
    sessionId: string | null = agent?.id ?? null,
  ): Promise<MemoryPageData> {
    const workspace =
      (await this.adapter.switches.get({ kind: 'workspace', id })) ?? DEFAULT_SWITCHES;
    const session = sessionId
      ? ((await this.adapter.switches.get({ kind: 'session', id: sessionId })) ?? DEFAULT_SWITCHES)
      : DEFAULT_SWITCHES;
    const files = await this.adapter.store.snapshot(id, true);
    const snapshot = sessionId
      ? await (await this.adapter.history).memorySnapshot(sessionId)
      : null;
    const local = snapshot?.files ?? new Map<string, string>();
    const rows = (values: Map<string, string>) =>
      [...values]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([path, content]) => ({ path, content, revision: digest(content) }));
    return {
      workspaceId: id,
      title: this.adapter.ctx.workspaceRegistry.list().find((w) => w.id === id)!.title,
      sessionId,
      sessionEditable: snapshot?.started ?? false,
      globalEnabled: this.adapter.config.enabled,
      workspace,
      session,
      effective: resolveSwitches(this.adapter.config.enabled, workspace, session),
      files: { workspace: rows(files), session: rows(local) },
      revisions: { workspace: snapshotRevision(files), session: snapshotRevision(local) },
    };
  }

  async change(target: PageTarget, action: PageAction): Promise<MemoryPageData> {
    if (action.op === 'switches') {
      const current = await this.read(target);
      if (!this.adapter.config.enabled)
        throw new StashError('STASH_DISABLED', '全局记忆已关闭，请在插件设置中开启');
      if (action.scope === 'session' && !current.sessionId)
        throw new StashError('STASH_INVALID_DATA', '需要当前会话');
      await this.adapter.switches.set(
        {
          kind: action.scope,
          id: action.scope === 'workspace' ? current.workspaceId : current.sessionId!,
        },
        action.value,
      );
      for (const agent of this.adapter.ctx.agents.list())
        await this.adapter.syncRegistration(agent, (await this.adapter.policy(agent)).enabled);
      return this.read(target);
    }
    if ((action.op === 'save' || action.op === 'clear') && action.scope === 'workspace') {
      const current = await this.read(target);
      const editor = new WorkspaceMemory(
        this.adapter.store,
        current.workspaceId,
        'ui',
        this.adapter.meter,
        this.adapter.config,
      );
      if (action.op === 'clear')
        await this.adapter.store.clear(current.workspaceId, action.expected);
      else await editor.editFromPage(action.path, action.content, action.expected);
      return this.read(target);
    }
    return this.withTarget(target, async (id, agent) => {
      const change = async () => {
        const memory = new WorkspaceMemory(
          this.adapter.store,
          id,
          'ui',
          this.adapter.meter,
          this.adapter.config,
        );
        const local = agent ? await this.adapter.sessionMemory(agent) : null;
        local?.store.reset();
        try {
          if (action.op === 'promote') {
            if (!agent || !local) throw new StashError('STASH_INVALID_DATA', '需要当前会话');
            const path = memoryPath(action.path, true);
            const destination = memoryPath(action.destination, true);
            if (!path.startsWith('/notes/') || !destination.startsWith('/notes/'))
              throw new StashError('STASH_INVALID_DATA', '只能提升笔记');
            const file = await local.store.read(agent.id, path);
            if (!file || file.revision !== action.expected)
              throw new StashError('STASH_STALE_READ', '原笔记已变化');
            await memory.editFromPage(
              destination,
              promoteNote(file.content, 'dsh://session/' + agent.id + path),
              null,
            );
          } else {
            if (!agent || !local) throw new StashError('STASH_INVALID_DATA', '需要当前会话');
            if (!agent.session.snapshotEvents().some((event) => event.type === 'system/message'))
              throw new StashError(
                'STASH_UNSUPPORTED',
                '请先发送本会话第一条消息，再编辑会话记忆；工作区编辑与开关可在此前使用',
              );
            if (action.op === 'clear') {
              const files = await local.store.snapshot();
              if (snapshotRevision(files) !== action.expected)
                throw new StashError('STASH_STALE_READ', '会话记忆已变化');
              for (const [path, content] of files) {
                await local.store.transact(
                  agent.id,
                  path,
                  digest(content),
                  'ui',
                  randomUUID(),
                  'delete',
                  () => ({ content: null, value: undefined }),
                );
              }
              const commits = local.store.pendingCommits();
              for (const commit of commits)
                agent.session.append('user/message', commitMessage(commit), {
                  surfaceOp: 'append',
                });
            } else {
              const editor = new WorkspaceMemory(
                local.store,
                agent.id,
                agent.id,
                this.adapter.meter,
                this.adapter.config,
                '.',
              );
              await editor.editFromPage(action.path, action.content, action.expected);
              agent.session.append('user/message', commitMessage(local.store.lastCommit()), {
                surfaceOp: 'append',
              });
            }
            await this.adapter.ctx.sessions.flush(agent.session);
          }
        } finally {
          local?.store.reset();
        }
      };
      if (agent) await agent.runMaintenance(change);
      else await change();
      return this.data(id, agent);
    });
  }
}
