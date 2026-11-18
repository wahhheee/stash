import { it, expect } from 'vitest';
import { healthCounts, previewPlan, resolveRedirect, parseNote } from '../src/index.ts';

it('未读按完整读取或创建算天数；提交不匹配与无法判定分开', () => {
  const files = new Map([
    [
      '/notes/a.md',
      '---\ntype: fact\ndescription: 新事实\nverified: 2026-01-01 @ fffffff\n---\n一',
    ],
    ['/notes/b.md', '---\ntype: fact\ndescription: 另一条\nverified: unknown\n---\n二'],
  ]);
  const old = '2026-01-01T00:00:00Z',
    recent = '2026-04-01T00:00:00Z';
  const usage = new Map(
    [...files.keys()].map((p, i) => [
      p,
      { reads: i, lastRead: i ? recent : null, created: i ? recent : old, updated: recent },
    ]),
  );
  expect(healthCounts(files, usage, Date.parse(recent), 90, old, 'aaaaaaa')).toEqual({
    notes: 2,
    added: 1,
    unread: 1,
    verifiedDifferent: 1,
    verifiedUnknown: 1,
  });
});

it('合并去重来源，拆分继承复杂元数据，重定向拒绝环路', () => {
  const a = '/notes/a.md',
    b = '/notes/b.md',
    d = '/notes/new.md';
  const file =
    '---\ntype: fact\ndescription: 主题\nsources: [事实, {ref: test}]\ncustom: 原值\n---\n一。二。';
  const files = new Map([
    [a, file],
    [b, file],
  ]);
  const rewrite = { path: a, description: '一', body: '一。' };
  const split = previewPlan(
    files,
    [{ op: 'split', ...rewrite, parts: [{ path: d, description: '二', body: '二。' }] }],
    new Map(),
  );
  expect(parseNote(split.changes[1]!.after!).fields).toMatchObject({
    sources: ['事实', { ref: 'test' }],
    custom: '原值',
  });
  const merged = previewPlan(files, [{ op: 'merge', ...rewrite, from: [b] }], new Map());
  expect(parseNote(merged.changes.find((c) => c.path === a)!.after!).fields.sources).toEqual([
    '事实',
    { ref: 'test' },
  ]);
  expect(() =>
    resolveRedirect(
      a,
      new Map([
        [a, b],
        [b, a],
      ]),
    ),
  ).toThrow();
  expect(() =>
    previewPlan(
      files,
      [
        {
          op: 'split',
          ...rewrite,
          parts: [{ path: a + '/part.md', description: '二', body: '二。' }],
        },
      ],
      new Map(),
    ),
  ).toThrow();
});
