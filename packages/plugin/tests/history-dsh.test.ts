import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { CompactionId } from '@deepseek-ai/dsh-compaction';
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { expect, it } from 'vitest';
import { DshHistory, historyProjection } from '../src/adapters/history-dsh.ts';
import { HistoryBrowser } from '../src/host/history.ts';
import { mountHistoryHost } from './history-host.ts';
import { viewHistory } from '../../devtools/src/history.ts';

it('真实投影持久缓存、分叉和压缩日志冷读，以及离线窗口一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stash-history-'));
  const boot = async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await mountHistoryHost(ctx, root);
    const handle = await ctx.sessionProjections.register(historyProjection);
    return { ctx, history: new DshHistory(ctx, handle) };
  };
  let { ctx, history } = await boot();
  try {
    const workspace = await ctx.workspaceRegistry.create(root);
    const session = ctx.sessions.create(SessionId('session-original'), { meta: { cwd: root } });
    session.append('turn/start', { turn: 1 });
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: '昨晚讨论架构' }],
        source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    );
    session.append('step/start', { turn: 1, step: 1 });
    const assistant = createAssistantMessage({
      content: [{ type: 'text', text: '结论使用字面扫描' }],
      source: { provider: 'mock', model: 'mock' },
    });
    session.append(
      'assistant/message',
      { turn: 1, step: 1, stream: [], message: assistant },
      { surfaceOp: 'append' },
    );
    session.append('step/end', { turn: 1, step: 1 });
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const fork = ctx.sessions.create(SessionId('session-fork'), {
      seed: session.snapshotEvents(),
      meta: { cwd: root, isSeeded: true },
      inheritedEventCount: SessionLogOffset(6),
    });
    const sources = [...session.surface.nodes];
    session.append('compaction/start', { compactionId: CompactionId('compact-test'), turn: null });
    session.append('compaction/summary', {
      compactionId: CompactionId('compact-test'),
      summary: [{ type: 'text', text: '讨论压缩摘要' }],
      shadowedRange: { start: sources[0]!, end: sources.at(-1)! },
      shadowedSeqs: sources,
      shadowedTokenCount: 100,
      provider: 'mock',
      model: 'mock',
    });
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: '讨论压缩摘要' }],
        source: compactCheckpointSource(CompactionId('compact-test')),
      }),
      {
        surfaceOp: { op: 'replace', startSeq: sources[0]!, endSeq: sources.at(-1)! },
        sourceEventSeqs: sources,
      },
    );
    session.append('compaction/end', { compactionId: CompactionId('compact-test'), turn: null });
    for (const s of [session, fork]) {
      const handle = await ctx.sessionPersistence.create(s.header, {
        inheritedEventCount: s.inheritedEventCount,
      });
      await handle.append(s.snapshotEvents());
      await handle.flush();
      await handle.close();
      await workspace.attachSession(s.id);
      await ctx.sessionProjectionCache.write(s);
    }
    expect(await history.reference(session.id, assistant.id)).toMatchObject({
      from: 0,
      to: 5,
      turn: 1,
    });
    const record = JSON.parse(
      await readFile(
        join(root, 'storage', 'session_projcache', 'sessions', session.id + '.json'),
        'utf8',
      ),
    ) as unknown;
    expect(JSON.stringify(record)).toContain('stashHistory');
    await ctx.fiber.dispose();
    ({ ctx, history } = await boot());
    expect(ctx.sessions.list()).toHaveLength(0);
    await history.session(session.id);
    const browser = new HistoryBrowser(
      history,
      workspace.id,
      session.id,
      { estimate: (t) => Math.ceil(t.length / 4) },
      4000,
    );
    expect(await browser.view({ path: './log/summaries' })).toContain('讨论压缩摘要');
    const search = await browser.view({ path: '/sessions', query: '架构', all: true });
    expect(search).toContain('also in forked session');
    const window = await browser.view({ path: './log/0..5' });
    expect(window).toContain('昨晚讨论架构');
    expect(
      await viewHistory(join(root, 'sessions'), root, session.id, { path: './log/0..5' }),
    ).toBe(window);
    expect(ctx.sessions.list()).toHaveLength(0);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
