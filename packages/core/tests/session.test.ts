import { expect, it } from 'vitest';
import {
  emptyCommits,
  foldCommit,
  commitFiles,
  sessionMemoryTarget,
  composeResident,
  decideResident,
  foldResident,
  renderResident,
  sessionWriteResult,
} from '../src/index.ts';
import type { MemoryCommit, ResidentState } from '../src/index.ts';

const meter = { estimate: (s: string) => Math.ceil(s.length / 4) };

const config = {
  rulesBudgetTokens: 1600,
  indexBudgetTokens: 1600,
  viewBudgetTokens: 4000,
  externalRuleUpdates: 'next-request' as const,
};

const commit: MemoryCommit = {
  v: 1,
  id: 'one',
  sessionId: 'source',
  path: '/RULES.md',
  content: '源规则',
  beforeRevision: null,
  revision: 'hash1',
};

it('折叠按切点继承，重复载体幂等，分支独立并拒绝坏链', () => {
  const seed = foldCommit(emptyCommits(), commit);
  expect(foldCommit(seed, commit)).toBe(seed);
  const fork = foldCommit(seed, {
    ...commit,
    id: 'two',
    sessionId: 'fork',
    content: '分支规则',
    beforeRevision: 'hash1',
    revision: 'hash2',
  });
  expect(commitFiles(seed).get('/RULES.md')).toBe('源规则');
  expect(commitFiles(fork).get('/RULES.md')).toBe('分支规则');
  expect(() => foldCommit(seed, { ...commit, id: 'three' })).toThrow('不连续');
  expect(() => foldCommit(seed, { ...commit, revision: 'bad' })).toThrow('冲突');
});

it('会话命名空间仅允许当前作用域写入，拒绝穿越和非法路径', () => {
  expect(sessionMemoryTarget('./notes/a.md', 'current')).toEqual({
    id: 'current',
    path: '/notes/a.md',
    explicit: true,
    writable: true,
  });
  expect(sessionMemoryTarget('../sibling/RULES.md', 'current')?.writable).toBe(false);
  expect(sessionMemoryTarget('dsh://session/sibling/notes/a.md', 'current')?.explicit).toBe(true);
  expect(() => sessionMemoryTarget('./notes/../a.md', 'current')).toThrow();
  expect(() => sessionMemoryTarget('./notes/CON.md', 'current')).toThrow();
  expect(sessionMemoryTarget('./log/1', 'current')).toBeNull();
});

it('分叉只追加位置通知，延后工作区更新不能被通知确认，会话改动仍及时生效', () => {
  const workspace = composeResident(new Map(), meter, 1600);
  const before: ResidentState = {
    ...workspace,
    session: { ...workspace, id: 'source', rules: '源规则' },
  };
  const after: ResidentState = { ...workspace, session: { ...before.session!, id: 'fork' } };
  expect(decideResident(before, after, 'workspace', meter, config).kind).toBe('position');
  const deferred = { ...after, rules: '外部规则' };
  expect(
    decideResident(before, deferred, 'workspace', meter, {
      ...config,
      externalRuleUpdates: 'next-compaction',
    }).kind,
  ).toBe('position');
  const visible = foldResident(
    [
      { v: 1, workspaceId: 'workspace', kind: 'full', state: before },
      { v: 1, workspaceId: 'workspace', kind: 'position', state: deferred },
    ],
    'workspace',
  );
  expect(visible?.rules).toBe('');
  expect(visible?.session?.id).toBe('fork');
  expect(
    decideResident(
      after,
      { ...after, session: { ...after.session!, rules: '新规则' } },
      'workspace',
      meter,
      { ...config, externalRuleUpdates: 'next-compaction' },
    ).reason,
  ).toBe('session-rules-changed');
  expect(renderResident('workspace', after)).toMatchSnapshot();
  expect(sessionWriteResult('Wrote /notes/a.md (workspace).', '/notes/a.md')).toContain('promote');
});

it('一次工作区写入不能确认未展示的会话规则', () => {
  const state: ResidentState = {
    rules: '',
    index: '',
    folded: false,
    session: { id: 's', rules: '旧', index: '', folded: false },
  };
  const folded = foldResident(
    [
      { v: 1, workspaceId: 'w', kind: 'full', state },
      {
        v: 1,
        workspaceId: 'w',
        kind: 'write',
        scope: 'workspace',
        state: { ...state, rules: '工作区', session: { ...state.session!, rules: '未展示' } },
      },
    ],
    'w',
  );
  expect(folded?.session?.rules).toBe('旧');
  expect(folded?.rules).toBe('工作区');
});

it('会话索引对路径前缀计入预算并保留描述原文', () => {
  const files = new Map([
    ['/notes/a.md', '---\ntype: lesson\ndescription: 使用 /notes/ 共享经验\n---\n正文'],
  ]);
  const state = composeResident(files, meter, 1600, '.');
  expect(state.index).toBe('- ./notes/a.md: 使用 /notes/ 共享经验 (lesson)');
});
