import { randomUUID } from 'node:crypto';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  DEFAULT_SWITCHES,
  resolveSwitches,
  StashError,
  promoteNote,
  memoryPath,
  projectNote,
  mergeNoteForm,
} from '@wahhheee/stash-core';
import { commitMessage } from './session-memory.ts';
import { digest, snapshotRevision } from './memory-store.ts';
import { WorkspaceMemory } from '../host/memory.ts';
import type { MemoryAdapter } from './memory-dsh.ts';
import type {
  PageTarget,
  PageAction,
  MemoryPageData,
  PageFile,
  PageMutation,
  PageMutationResult,
} from '../page-types.ts';

function pageFile(path: string, content: string): PageFile {
  if (path === '/RULES.md') return { path, content, revision: digest(content) };
  try {
    return { path, content, revision: digest(content), note: projectNote(content) };
  } catch {
    return { path, content, revision: digest(content), note: null };
  }
}

/** Remote 只操作用户指定的范围；会话提交占用宿主维护时段，防止和工具写入交错。 */
export class MemoryPage {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly mutations = new Map<
    string,
    { fingerprint: string; result: Promise<PageMutationResult> }
  >();

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
        .map(([path, content]) => pageFile(path, content));
    return {
      workspaceId: id,
      title: this.adapter.ctx.workspaceRegistry.list().find((w) => w.id === id)!.title,
      sessionId,
      sessionTitle: snapshot?.title ?? '',
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
    await this.apply(target, action);
    return this.read(target);
  }

  /** 回执与刷新分离；同一次请求重试复用结果，避免确认丢失后重复创建。 */
  async mutate(target: PageTarget, request: PageMutation): Promise<PageMutationResult> {
    const key = target.kind + ':' + target.id + ':' + request.id;
    const fingerprint = digest(JSON.stringify(request.action));
    const previous = this.mutations.get(key);
    if (previous)
      return previous.fingerprint === fingerprint
        ? previous.result
        : { ok: false, code: 'STASH_INVALID_DATA' };
    const result = this.performMutation(target, request).catch((): PageMutationResult => ({
      ok: false,
      code: 'STASH_IO_ERROR',
    }));
    this.mutations.set(key, { fingerprint, result });
    const value = await result;
    if (!value.ok) this.mutations.delete(key);
    if (this.mutations.size > 256) this.mutations.delete(this.mutations.keys().next().value!);
    return value;
  }

  private async performMutation(
    target: PageTarget,
    request: PageMutation,
  ): Promise<PageMutationResult> {
    try {
      let action: PageAction;
      if (request.action.op === 'note') {
        const input = request.action;
        const path = memoryPath(input.path, true);
        if (!path.startsWith('/notes/'))
          return { ok: false, code: 'STASH_INVALID_DATA', field: 'path' };
        const data = await this.read(target);
        const previous = data.files[input.scope].find((file) => file.path === path);
        if (input.expected === null && previous)
          return { ok: false, code: 'STASH_ALREADY_EXISTS', field: 'path' };
        if (input.expected !== null && previous?.revision !== input.expected)
          return { ok: false, code: 'STASH_STALE_READ' };
        action = {
          op: 'save',
          scope: input.scope,
          path,
          expected: input.expected,
          content: mergeNoteForm(previous?.content ?? null, input.value),
        };
      } else action = request.action;
      return await this.apply(target, action);
    } catch (cause) {
      if (cause instanceof StashError) {
        const detail = cause.detail;
        return {
          ok: false,
          code: cause.code,
          ...(detail?.kind === 'note-field' ? { field: detail.field } : {}),
          ...(detail?.kind === 'invalid-path' || detail?.kind === 'path-case'
            ? { field: 'path' }
            : {}),
          ...(detail?.kind === 'rules-budget' ? { used: detail.used, limit: detail.limit } : {}),
        };
      }
      return {
        ok: false,
        code:
          cause instanceof Error && /busy|maintenance|running/iu.test(cause.message)
            ? 'STASH_BUSY'
            : 'STASH_IO_ERROR',
      };
    }
  }

  private async apply(
    target: PageTarget,
    action: PageAction,
  ): Promise<Extract<PageMutationResult, { ok: true }>> {
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
      return { ok: true, scope: action.scope, file: null, cleared: false };
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
      return {
        ok: true,
        scope: 'workspace',
        file:
          action.op === 'save' && action.content !== null
            ? pageFile(action.path, action.content)
            : null,
        cleared: action.op === 'clear',
      };
    }
    return this.withTarget(target, async (id, agent) => {
      let file: PageFile | null = null;
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
            const source = await local.store.read(agent.id, path);
            if (!source || source.revision !== action.expected)
              throw new StashError('STASH_STALE_READ', '原笔记已变化');
            const content = promoteNote(source.content, 'dsh://session/' + agent.id + path);
            await memory.editFromPage(destination, content, null);
            file = pageFile(destination, content);
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
      if (action.op === 'save' && action.content !== null)
        file = pageFile(action.path, action.content);
      return {
        ok: true,
        scope: action.op === 'promote' ? 'workspace' : 'session',
        file,
        cleared: action.op === 'clear',
      };
    });
  }
}
