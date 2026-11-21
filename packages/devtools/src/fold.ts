import { Context } from '@deepseek-ai/cordis';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { SessionId } from '@deepseek-ai/dsh-session';
import { sessionId, emptyCommits, foldCommit } from '@wahhheee/stash-core';
import { eventCommits } from '../../plugin/src/adapters/session-memory.ts';

/** 离线逐提交折叠只使用宿主 read 句柄，不创建投影缓存。 */
export async function foldLog(root: string, id: string) {
  const ctx = new Context();
  try {
    await ctx.plugin(Persistence, { root });
    const handle = await ctx.sessionPersistence.open(SessionId(sessionId(id)), 'read');
    try {
      const { events } = await handle.read();
      let state = emptyCommits();
      const steps = [];
      for (const event of events) {
        for (const commit of eventCommits(event)) {
          state = foldCommit(state, commit);
          steps.push({ seq: event.seq, commit, files: state.files });
        }
      }
      return steps;
    } finally {
      await handle.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
