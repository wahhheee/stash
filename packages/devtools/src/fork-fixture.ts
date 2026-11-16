import { Context } from '@deepseek-ai/cordis';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';

/** SDK 没有分叉端点，测试在宿主停止后调用相同 SessionStore 分叉实现。 */
export async function forkFixture(root: string, sourceId: string, childId: string): Promise<void> {
  const ctx = new Context();
  try {
    await ctx.plugin(Sessions);
    await ctx.plugin(Persistence, { root });
    const source = await ctx.sessionPersistence.open(SessionId(sourceId), 'read');
    try {
      const { events } = await source.read();
      const session = ctx.sessions.create(source.id, {
        seed: events,
        meta: source.header,
        inheritedEventCount: source.inheritedEventCount,
      });
      const child = ctx.sessions.fork(session, undefined, SessionId(childId));
      const handle = await ctx.sessionPersistence.create(child.header, {
        inheritedEventCount: child.inheritedEventCount,
      });
      try {
        await handle.append(child.snapshotEvents());
        await handle.flush();
      } finally {
        await handle.close();
      }
    } finally {
      await source.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
