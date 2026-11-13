import { describe, expect, it } from 'vitest';
import { MemoryFiles, MemorySessionLog, MemorySearch } from '../src/testing/memory.ts';
import { MODEL_SURFACE } from '../src/index.ts';

describe('领域测试端口', () => {
  it('并发修改只有一个写入者成功，日志保留全文且读取隔离', async () => {
    const files = new MemoryFiles();
    const first = await files.write('w', '/RULES.md', '原文', null);
    const revision = first.after!.revision;
    const results = await Promise.allSettled([
      files.write('w', '/RULES.md', '甲', revision),
      files.write('w', '/RULES.md', '乙', revision),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { code: 'STASH_STALE_READ' } });
    expect(await files.journal('w')).toMatchObject([
      { before: null },
      { before: { content: '原文' }, after: { content: '甲' } },
    ]);
    expect(await files.read('other', '/RULES.md')).toBeNull();
    const file = await files.read('w', '/RULES.md');
    Object.assign(file!, { content: '污染' });
    expect((await files.read('w', '/RULES.md'))!.content).toBe('甲');
  });
  it('隐藏事件仍可检索，缺失与零结果可区分', async () => {
    const logs = new MemorySessionLog();
    logs.seed('s', []);
    await logs.append('s', { timestamp: '2026-01-01T00:00:00Z', kind: 'user', text: '讨论架构' });
    logs.hide('s', [0]);
    expect(await logs.visible('s')).toEqual([]);
    const search = new MemorySearch(logs);
    expect(await search.search({ sessionIds: ['s'], query: '架构', limit: 1 })).toMatchObject({
      hits: [{ seq: 0 }],
      truncated: false,
    });
    expect((await search.search({ sessionIds: ['s'], query: '未命中', limit: 1 })).hits).toEqual(
      [],
    );
    await expect(logs.read('missing')).rejects.toMatchObject({ code: 'STASH_NOT_FOUND' });
  });
  it('检索时间窗按时刻比较，拒绝无效边界', async () => {
    const logs = new MemorySessionLog();
    logs.seed('s', []);
    await logs.append('s', { timestamp: '2026-01-01T07:30:00+08:00', kind: 'user', text: 'match' });
    await logs.append('s', { timestamp: '2026-01-01T00:30:00Z', kind: 'user', text: 'match' });
    const search = new MemorySearch(logs);
    expect(
      (
        await search.search({
          sessionIds: ['s'],
          query: 'match',
          since: '2026-01-01T00:00:00Z',
          limit: 1,
        })
      ).hits.map((e) => e.seq),
    ).toEqual([1]);
    await expect(
      search.search({ sessionIds: ['s'], query: 'match', since: 'bad', limit: 1 }),
    ).rejects.toMatchObject({ code: 'STASH_INVALID_DATA' });
  });
  it('工作区模型表面快照附估算量', () => {
    expect({
      ...MODEL_SURFACE,
      tokens: Math.ceil(MODEL_SURFACE.instructions.length / 4),
    }).toMatchSnapshot();
  });
});
