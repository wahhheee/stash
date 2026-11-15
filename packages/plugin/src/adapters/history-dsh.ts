import type { Context } from '@deepseek-ai/cordis';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { extractSessionEventText } from '@deepseek-ai/dsh-session-query';
import type { ProjectionDefinition, ProjectionHandle } from '@deepseek-ai/dsh-session-projection';
import type {} from '@deepseek-ai/dsh-workspace';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { z } from 'zod';
import { foldHistoryTurn, sessionId, StashError } from '@wahhheee/stash-core';
import type {
  HistoryEvent,
  HistoryPort,
  HistoryTurn,
  EventWindow,
  WorkspacePort,
} from '@wahhheee/stash-core';
import { digest } from './memory-store.ts';
import { redact } from './redaction.ts';

export function historyEvent(id: string, event: SessionEvent, inherited: number): HistoryEvent {
  return {
    sessionId: id,
    seq: event.seq,
    timestamp: new Date(event.time).toISOString(),
    kind: event.type,
    text: redact(extractSessionEventText(event)),
    full: redact(JSON.stringify(event)),
    inherited: event.seq < inherited,
    fingerprint: digest(JSON.stringify(event)),
    ...(event.type === 'turn/start' ? { turn: event.data.turn } : {}),
    ...(event.type === 'user/message'
      ? {
          human: event.data.source.kind === 'user',
          ...(isCompactCheckpointSource(event.data.source)
            ? { summary: [...(event.sourceEventSeqs ?? [])] }
            : {}),
        }
      : {}),
  };
}

const turnSchema: z.ZodType<HistoryTurn> = z
  .object({
    turn: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
    prompt: z.string().max(120),
    response: z.string().max(240),
    complete: z.boolean(),
  })
  .strict();

export const historyProjection: ProjectionDefinition<'stashHistory', readonly HistoryTurn[]> = {
  key: 'stashHistory',
  stateVersion: 1,
  stateSchema: z.array(turnSchema),
  init: () => [],
  apply: (state, event) =>
    foldHistoryTurn(state, {
      kind: event.type,
      seq: event.seq,
      timestamp: new Date(event.time).toISOString(),
      text:
        event.type === 'user/message' || event.type === 'assistant/message'
          ? redact(extractSessionEventText(event))
          : '',
      ...(event.type === 'turn/start' ? { turn: event.data.turn } : {}),
      ...(event.type === 'user/message' ? { human: event.data.source.kind === 'user' } : {}),
    }),
};

/** 使用宿主只读观察租约；不恢复 agent，不修改原始日志。 */
export class DshHistory implements HistoryPort, WorkspacePort {
  constructor(
    private readonly ctx: Context,
    private readonly projection: ProjectionHandle<readonly HistoryTurn[]>,
  ) {}

  private async inspect<T>(id: string, read: (session: Session) => T): Promise<T> {
    const key = SessionId(sessionId(id));
    // all 模式从宿主持久检查点恢复投影；租约保证冷读对象存活至同步读取结束。
    const observation = await this.ctx.sessionQuery.observeSession(key, { projectionMode: 'all' });
    try {
      return await this.ctx.sessionQuery.inspectSession(key, read);
    } finally {
      observation[Symbol.dispose]();
    }
  }

  async get(id: string) {
    const workspace = this.ctx.workspaceRegistry.list().find((w) => w.id === id);
    return workspace
      ? { id: workspace.id, title: workspace.title, sessionIds: [...workspace.sessionIds] }
      : null;
  }

  async forSession(id: string) {
    const workspace = this.ctx.workspaceRegistry
      .list()
      .find((w) => w.sessionIds.includes(SessionId(id)));
    return workspace ? this.get(workspace.id) : null;
  }

  async ids(workspaceId: string) {
    const workspace = await this.get(workspaceId);
    if (!workspace) throw new StashError('STASH_NOT_FOUND', '工作区不存在');
    return workspace.sessionIds;
  }

  async session(id: string) {
    return this.inspect(id, (session) => {
      const raw = session.snapshotEvents();
      const title = raw.findLast((e) => e.type === 'session/title');
      const events = raw.map((e) => historyEvent(id, e, session.inheritedEventCount));
      const turns = this.projection.stateOf(session).map((t) => ({ ...t }));
      return {
        id,
        title: redact(title?.type === 'session/title' ? title.data.title : id),
        created: new Date(session.header.createdAt).toISOString(),
        events,
        turns,
      };
    });
  }

  async read(id: string, window?: EventWindow) {
    return (await this.session(id)).events.filter(
      (e) => !window || (e.seq >= window.from && e.seq <= window.to),
    );
  }

  async reference(id: string, messageId: string) {
    return this.inspect(id, (session) => {
      const event = session
        .snapshotEvents()
        .find((e) => e.type === 'assistant/message' && e.data.message.id === messageId);
      const turn =
        event &&
        this.projection
          .stateOf(session)
          .find((t) => t.from <= event.seq && t.to >= event.seq && t.complete);
      if (!turn) throw new StashError('STASH_NOT_FOUND', '未找到已完成轮次');
      const title = session.snapshotEvents().findLast((e) => e.type === 'session/title');
      return {
        id,
        title: redact(title?.type === 'session/title' ? title.data.title : id),
        ...turn,
      };
    });
  }
}
