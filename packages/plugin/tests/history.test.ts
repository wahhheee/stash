import { expect, it } from 'vitest';
import { HistoryBrowser } from '../src/host/history.ts';
import type { HistoryEvent, HistoryPort, HistorySession } from '@wahhheee/stash-core';

function fixture(budget = 4000) {
  const a = 'session-abcdefgh-one',
    b = 'session-abcdefgh-two';
  const events: HistoryEvent[] = [
    {
      sessionId: a,
      seq: 0,
      timestamp: '2026-11-14T23:00:00Z',
      kind: 'user/message',
      text: '架构  PLAN',
      full: '完整推理',
      fingerprint: 'one',
      inherited: false,
    },
    {
      sessionId: a,
      seq: 1,
      timestamp: '2026-11-14T23:01:00Z',
      kind: 'assistant/message',
      text: '采用方案',
      full: '完整回答',
      fingerprint: 'two',
      inherited: false,
    },
    {
      sessionId: a,
      seq: 2,
      timestamp: '2026-11-15T00:00:00Z',
      kind: 'user/message',
      text: '压缩摘要',
      full: '完整摘要',
      summary: [0, 1],
      fingerprint: 'summary',
      inherited: false,
    },
  ];
  const session: HistorySession = {
    id: a,
    title: '昨晚讨论',
    created: events[0]!.timestamp,
    events,
    turns: [
      {
        turn: 1,
        from: 0,
        to: 1,
        start: events[0]!.timestamp,
        end: events[1]!.timestamp,
        prompt: '架构',
        response: '采用方案',
        complete: true,
      },
    ],
  };
  const sessions = new Map([
    [a, session],
    [
      b,
      {
        ...session,
        id: b,
        events: events.slice(0, 2).map((e) => ({ ...e, sessionId: b, inherited: true })),
      },
    ],
    ['outside', { ...session, id: 'outside' }],
  ]);
  const port: HistoryPort = {
    ids: async () => [a, b],
    session: async (id) => {
      const value = sessions.get(id);
      if (!value) throw Error('unreadable');
      return value;
    },
    read: async (id) => (await port.session(id)).events,
  };
  const browser = new HistoryBrowser(
    port,
    'w',
    a,
    { estimate: (t) => Math.ceil(t.length / 4) },
    budget,
  );
  return { browser, sessions, a, b };
}

it('昨晚场景：清单、轮次、单事件扩展、精确窗口和压缩摘要', async () => {
  const { browser, a } = fixture();
  expect(
    await browser.view({
      path: '/sessions',
      since: '2026-11-14T16:00-07:00',
      until: '2026-11-14T17:00-07:00',
    }),
  ).toContain('昨晚讨论');
  expect(await browser.view({ path: './log/turns' })).toContain('Turn 1');
  expect(await browser.view({ path: sessionRef(a, 0) })).toContain('采用方案');
  expect(await browser.view({ path: './log/0..1', detail: 'full' })).toContain('完整推理');
  expect(await browser.view({ path: './log/summaries' })).toContain('Source event seqs: 0,1');
  await expect(browser.view({ path: './log/0..9', query: '不存在' })).rejects.toMatchObject({
    code: 'STASH_NOT_FOUND',
  });
  await expect(browser.view({ path: './log/0..9' })).rejects.toMatchObject({
    code: 'STASH_NOT_FOUND',
  });
});

function sessionRef(id: string, seq: number) {
  return 'dsh://session/' + id + '/' + seq;
}

it('字面搜索限定范围、中文与空白匹配、前缀去重和零结果', async () => {
  const { browser } = fixture();
  await expect(browser.view({ path: '/sessions', query: '架构' })).rejects.toMatchObject({
    code: 'STASH_SCOPE_REQUIRED',
  });
  const result = await browser.view({ path: '/sessions', query: '架构 plan', all: true });
  expect(result).toContain('also in forked session');
  expect(result).toContain('scanned sessions: 2');
  expect(await browser.view({ path: './log', query: '不匹配' })).toContain('status: no-match');
  expect(
    await browser.view({ path: './log', query: '架构', since: '2026-11-15T00:00Z' }),
  ).toContain('status: no-match');
});

it('跨工作区仅完整引用；不可读和搜索失败绝不返回空结果', async () => {
  const { browser, sessions, b } = fixture();
  await expect(browser.view({ path: '/sessions/outside/log/turns' })).rejects.toMatchObject({
    code: 'STASH_NOT_FOUND',
  });
  expect(await browser.view({ path: 'dsh://session/outside' })).toContain('Turn 1');
  sessions.delete(b);
  await expect(browser.view({ path: '/sessions' })).rejects.toMatchObject({
    code: 'STASH_HISTORY_UNREADABLE',
  });
  await expect(browser.view({ path: '/sessions', query: '架构', all: true })).rejects.toMatchObject(
    { code: 'STASH_SEARCH_FAILED' },
  );
});

it('分页快照绑定参数与 agent，追加日志期间可完成续读且遵守预算', async () => {
  const { browser, sessions, a } = fixture(256);
  const s = sessions.get(a)!;
  sessions.set(a, {
    ...s,
    events: s.events.map((e) => ({ ...e, full: '很长的原始内容'.repeat(1000) })),
  });
  const input = { path: './log/0..1', detail: 'full' as const };
  let page = await browser.view(input),
    count = 0;
  while (page.includes('cursor=')) {
    expect(Math.ceil(page.length / 4)).toBeLessThanOrEqual(256);
    const cursor = page.split('cursor=')[1]!;
    if (count === 0) {
      await expect(browser.view({ ...input, path: './log/turns', cursor })).rejects.toMatchObject({
        code: 'STASH_STALE_READ',
      });
      await expect(fixture().browser.view({ ...input, cursor })).rejects.toMatchObject({
        code: 'STASH_STALE_READ',
      });
      sessions.delete(a);
    }
    page = await browser.view({ ...input, cursor });
    expect(++count).toBeLessThan(100);
  }
  expect(page).toContain('[complete]');
});
