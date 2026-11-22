import { Context } from '@deepseek-ai/cordis';
import Sessions, { SessionId } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { mountHistoryHost } from '../../plugin/tests/history-host.ts';
import { historyProjection, DshHistory } from '../../plugin/src/adapters/history-dsh.ts';
import { HistoryBrowser } from '../../plugin/src/host/history.ts';

/** 生成无凭据的合成一周日志；保留输出，便于在不同磁盘复测。 */
const base = resolve(process.argv[2] ?? '.exclude/history-benchmark');
await mkdir(base, { recursive: true });
const root = await mkdtemp(join(base, 'run-'));

const boot = async () => {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  await ctx.plugin(Projections);
  await mountHistoryHost(ctx, root);
  return {
    ctx,
    history: new DshHistory(ctx, await ctx.sessionProjections.register(historyProjection)),
  };
};

let { ctx } = await boot();

let bytes = 0;

try {
  const workspace = await ctx.workspaceRegistry.create(root);
  const workspaceId = workspace.id;
  for (let n = 0; n < 28; n++) {
    const session = ctx.sessions.create(SessionId('session-benchmark-' + n), {
      meta: { cwd: root, createdAt: Date.UTC(2026, 10, 9) + Math.floor(n / 4) * 86400000 },
    });
    for (let turn = 1; turn <= 100; turn++) {
      session.append('turn/start', { turn });
      session.append(
        'user/message',
        createUserMessage({
          source: { kind: 'user' },
          content: [
            {
              type: 'text',
              text: (turn === 50 ? '架构方案' : '开发任务') + ' 条件和上下文'.repeat(200),
            },
          ],
        }),
        { surfaceOp: 'append' },
      );
      session.append('step/start', { turn, step: 1 });
      session.append(
        'assistant/message',
        {
          turn,
          step: 1,
          stream: [],
          message: createAssistantMessage({
            source: { provider: 'mock', model: 'mock' },
            content: [{ type: 'text', text: '实现细节与讨论结论。'.repeat(200) }],
          }),
        },
        { surfaceOp: 'append' },
      );
      session.append('step/end', { turn, step: 1 });
      session.append('turn/end', { turn, reason: { kind: 'completed' } });
    }
    const raw = session.snapshotEvents();
    bytes += Buffer.byteLength(JSON.stringify(raw));
    const handle = await ctx.sessionPersistence.create(session.header);
    await handle.append(raw);
    await handle.flush();
    await handle.close();
    await workspace.attachSession(session.id);
    await ctx.sessionProjectionCache.write(session);
  }
  await ctx.fiber.dispose();
  const rebooted = await boot();
  ctx = rebooted.ctx;
  const { history } = rebooted;
  const times: number[] = [];
  for (let i = 0; i < 4; i++) {
    const browser = new HistoryBrowser(
      history,
      workspaceId,
      'session-benchmark-0',
      { estimate: (t) => Math.ceil(t.length / 4) },
      64000,
    );
    const start = performance.now();
    const text = await browser.view({ path: '/sessions', query: '架构', all: true });
    times.push(Math.round(performance.now() - start));
    if (!text.includes('scanned sessions: 28') || !text.includes('status: matched'))
      throw new Error('基准覆盖范围错误');
  }
  const report = {
    format: 1,
    sessions: 28,
    turns: 2800,
    events: 16800,
    logicalBytes: bytes,
    milliseconds: times,
    note: '首次为重建宿主后的冷观察；未清除操作系统磁盘缓存。后续为同宿主观察缓存。合成数据使用默认 zstd 持久格式。',
  };
  await writeFile(join(root, 'measurement.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ root, ...report }, null, 2));
} finally {
  await ctx.fiber.dispose();
}
