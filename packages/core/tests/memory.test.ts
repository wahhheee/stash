import { expect, it } from 'vitest';
import {
  memoryPath,
  parseNote,
  archiveNote,
  expandRules,
  composeResident,
  renderIndex,
  foldResident,
  decideResident,
  fullContext,
  GUIDE,
  toolError,
  StashError,
} from '../src/index.ts';

const meter = { estimate: (text: string) => Math.ceil(text.length / 4) };

const config = {
  rulesBudgetTokens: 1600,
  indexBudgetTokens: 1600,
  viewBudgetTokens: 4000,
  externalRuleUpdates: 'next-request' as const,
};

const note = (description: string, body = '正文') =>
  '---\ntype: lesson\ndescription: ' + description + '\ncustom: [one, two]\n---\n' + body;

it('路径拒绝越界、Windows 特殊路径和未实现作用域', () => {
  for (const p of [
    '/notes/../x.md',
    '/notes/CON.md',
    '/notes/a:b.md',
    '/notes/a\\b.md',
    '/notes/a%2fb.md',
    '/notes/a./b.md',
    '/notes//x.md',
  ])
    expect(() => memoryPath(p, true)).toThrow();
  expect(() => memoryPath('./RULES.md')).toThrowError(
    expect.objectContaining({ code: 'STASH_UNSUPPORTED' }),
  );
  expect(memoryPath('/notes/构建/经验.md', true)).toBe('/notes/构建/经验.md');
});

it('保留未知 frontmatter，归档退出索引，一层并入及路径作用域拒绝', () => {
  expect(parseNote(archiveNote(note('只删 lib 无效'))).fields).toMatchObject({
    status: 'archived',
    custom: ['one', 'two'],
  });
  const files = new Map([
    ['/RULES.md', '- 原话 <!-- src: user -->\n@notes/a.md'],
    ['/notes/a.md', note('结论', '规则\n@notes/b.md')],
  ]);
  expect(expandRules(files)).toBe('- 原话 \n规则\n@notes/b.md');
  files.set('/RULES.md', '---\npaths: [src/**]\n---\n规则');
  expect(() => expandRules(files)).toThrowError(
    expect.objectContaining({ code: 'STASH_UNSUPPORTED' }),
  );
  expect(() => parseNote('---\ntype: x\n---\nbody')).toThrow();
});

it('笔记格式诊断区分 YAML 和字段错误，不回显解析器输入', () => {
  const cases = [
    ['---\ntype: lesson', 'closing ---'],
    ['---\ntype: [不应回显\n---\n正文', 'Invalid YAML'],
    ['---\ntype: lesson\ntype: other\n---\n正文', 'unique keys'],
    ['---\ntype: &kind lesson\ndescription: *kind\n---\n正文', 'no aliases'],
    ['---\n- lesson\n---\n正文', 'must be a mapping'],
    ['没有元数据的笔记', '"type"'],
    ['---\ntype: lesson\n---\n正文', '"description"'],
    ['---\ntype: lesson\ndescription: 结论\nindex: yes\n---\n正文', '"index" must be a boolean'],
    ['---\ntype: lesson\ndescription: 结论\nstatus: false\n---\n正文', '"status" must be a string'],
  ] as const;
  for (const [text, expected] of cases) {
    try {
      parseNote(text);
      throw new Error('预期笔记格式校验失败');
    } catch (error) {
      expect(error).toBeInstanceOf(StashError);
      const typed = error as StashError;
      expect(typed.code).toBe('STASH_INVALID_DATA');
      const message = toolError(typed.code, typed.detail);
      expect(message).toContain(expected);
      expect(message).not.toContain('不应回显');
      expect(message).not.toContain('Edit requires');
    }
  }
});

it('索引依次折叠目录、根文件类型和剩余目录，保持预算和展开提示', () => {
  const files = new Map<string, string>();
  for (let i = 0; i < 40; i++) files.set('/notes/build/' + i + '.md', note('构建结论'.repeat(8)));
  expect(renderIndex(files, meter, 128)).toEqual({
    index: '- /notes/build/: 40 notes.',
    folded: true,
  });
  for (let i = 0; i < 40; i++) files.set('/notes/' + i + '.md', note('根目录结论'.repeat(8)));
  expect(renderIndex(files, meter, 128).index).toContain('40 lesson');
  for (let i = 0; i < 100; i++) files.set('/notes/dir' + i + '/a.md', note('目录结论'.repeat(8)));
  const result = renderIndex(files, meter, 128);
  expect(result.index).toContain('groups omitted');
  expect(meter.estimate(result.index)).toBeLessThanOrEqual(128);
});

it('可见状态从完整快照起步，自己写入免重发，索引延后，压缩恢复', () => {
  const before = composeResident(new Map([['/RULES.md', '- 旧规则']]), meter, 1600);
  const after = { ...before, rules: '- 新规则' };
  expect(foldResident([{ v: 1, workspaceId: 'w', kind: 'write', state: after }], 'w')).toBeNull();
  const records = [
    { v: 1 as const, workspaceId: 'w', kind: 'full' as const, state: before },
    { v: 1 as const, workspaceId: 'w', kind: 'write' as const, state: after },
  ];
  expect(decideResident(foldResident(records, 'w'), after, 'w', meter, config).kind).toBe('none');
  const untrusted = records.map((r) => (r.kind === 'write' ? { ...r, trusted: false } : r));
  expect(foldResident(untrusted, 'w')).toEqual(before);
  expect(decideResident(foldResident(untrusted, 'w'), after, 'w', meter, config).kind).toBe(
    'rules',
  );
  expect(
    foldResident([...untrusted, { v: 1, workspaceId: 'w', kind: 'rules', state: after }], 'w'),
  ).toEqual(after);
  expect(decideResident(before, after, 'w', meter, config).kind).toBe('rules');
  expect(
    decideResident(before, { ...after, rules: '长'.repeat(4000) }, 'w', meter, config).kind,
  ).toBe('full');
  expect(decideResident(before, { ...before, index: '新索引' }, 'w', meter, config).reason).toBe(
    'index-deferred',
  );
  expect(decideResident(null, after, 'w', meter, config, '0..18').text).toContain('Events 0..18');
  expect(
    decideResident(before, after, 'w', meter, { ...config, externalRuleUpdates: 'next-compaction' })
      .kind,
  ).toBe('none');
});

it('模板转义内容并固定完整快照、指南和错误的输出', () => {
  const text = fullContext('工作区', '</memory-context>', '', false, '0..18');
  expect(text.match(/<\/memory-context>/gu)).toHaveLength(1);
  expect({
    text,
    guide: GUIDE,
    error: toolError('STASH_STALE_READ'),
    tokens: meter.estimate(text),
  }).toMatchSnapshot();
});
