import { Context } from '@deepseek-ai/cordis';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { foldHistoryTurn, sessionId } from '@wahhheee/stash-core';
import type { HistoryPort, HistoryTurn } from '@wahhheee/stash-core';
import { historyEvent } from '../../plugin/src/adapters/history-dsh.ts';
import { HistoryBrowser } from '../../plugin/src/host/history.ts';
import type { HistoryInput } from '../../plugin/src/host/history.ts';
import { offlineMeter } from './reconcile.ts';
import { redact } from '../../plugin/src/adapters/redaction.ts';

/** 离线目录缺少工作区注册表，清单仅使用已验证工作区路径的精确 cwd 匹配。 */
export async function viewHistory(
  root: string,
  workspacePath: string,
  current: string,
  input: HistoryInput,
): Promise<string> {
  sessionId(current);
  const ctx = new Context();
  try {
    await ctx.plugin(Persistence, { root });
    const port: HistoryPort = {
      ids: async () =>
        (await ctx.sessionPersistence.list())
          .filter((s) => s.header.cwd === workspacePath)
          .map((s) => s.header.id),
      session: async (id) => {
        const handle = await ctx.sessionPersistence.open(SessionId(sessionId(id)), 'read');
        try {
          const { events: raw } = await handle.read();
          const session = Session.create(handle.id, raw, handle.header, handle.inheritedEventCount);
          const events = session
            .snapshotEvents()
            .map((e) => historyEvent(id, e, handle.inheritedEventCount));
          const turns = events.reduce<readonly HistoryTurn[]>(
            (state, e) => foldHistoryTurn(state, e),
            [],
          );
          const title = raw.findLast((e) => e.type === 'session/title');
          return {
            id,
            title: redact(title?.type === 'session/title' ? title.data.title : id),
            created: new Date(handle.header.createdAt).toISOString(),
            events,
            turns,
          };
        } finally {
          await handle.close();
        }
      },
      read: async (id) => (await port.session(id)).events,
    };
    const browser = new HistoryBrowser(port, 'offline', current, offlineMeter, 4000);
    const pages: string[] = [];
    let page = await browser.view(input);
    for (;;) {
      pages.push(page);
      const cursor = /cursor=([a-f0-9-]+)$/u.exec(page)?.[1];
      if (!cursor) return pages.join('\n');
      page = await browser.view({ ...input, cursor });
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
