import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { it, expect, afterEach } from 'vitest';
import { FileMemoryStore, memoryFile, snapshotRevision } from '../src/adapters/memory-store.ts';
import { WorkspaceMemory } from '../src/host/memory.ts';
import { validatePlan } from '../src/host/maintenance.ts';
import { FOLD_HINT, decideResident } from '@wahhheee/stash-core';
import type { PlanStep } from '@wahhheee/stash-core';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const meter = { estimate: (s: string) => Math.ceil(s.length / 4) };

const config = {
  rulesBudgetTokens: 300,
  indexBudgetTokens: 24,
  viewBudgetTokens: 180,
  externalRuleUpdates: 'next-request' as const,
};

const validate = (f: ReadonlyMap<string, string>) => validatePlan(f, meter, config);
const group = () => 'stash-maint-' + randomUUID();

const note = (name: string) =>
  `---\r\ntype: fact\r\ndescription: 一个需要单独修订的主题\r\nsources: [${name}]\r\n---\r\n${name}\r\n`;

const a = '/notes/a.md',
  b = '/notes/b.md',
  c = '/notes/c.md';

const merge: PlanStep = {
  op: 'merge',
  path: a,
  from: [b],
  body: '合并事实',
  description: '应先检查',
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stash-plan-'));
  roots.push(root);
  const store = new FileMemoryStore(root);
  const dir = store.directory('w');
  await store.ensure({ format: 1, id: 'w', path: root, title: '测试' });
  await mkdir(join(dir, 'notes'));
  for (const path of [a, b, c]) await writeFile(join(dir, path), note(path));
  const memory = new WorkspaceMemory(store, 'w', 'session', meter, config);
  const plan = async (steps: PlanStep[]) => {
    const id = group();
    await store.startPlan('w', id);
    return store.plan(
      'w',
      id,
      { kind: 'propose', steps, seen: snapshotRevision(await store.snapshot('w')) },
      validate,
    );
  };
  return {
    dir,
    root,
    store,
    memory,
    plan,
    apply: (r: Awaited<ReturnType<typeof plan>>, confirmed = r.rules.map((x) => x.line)) =>
      store.plan('w', r.id, { kind: 'apply', revision: r.revision, confirmed }, validate),
  };
}

it('从旧路径分页得到规范正文，完整读只记一次；别名不发放写凭据，回滚保留无关修改', async () => {
  const { store, memory, dir, root, plan, apply } = await fixture();
  const before = await memory.actual();
  const initial = await store.snapshot('w');
  const r = await plan([{ ...merge, body: '长'.repeat(1750) }]);
  await apply(r);
  const reader = new WorkspaceMemory(new FileMemoryStore(root), 'w', 'other', meter, config);
  let text = await reader.view(b);
  expect(text).toContain('Redirect: ' + b + ' → ' + a);
  expect((await store.maintenanceState('w')).usage.get(a)?.reads).toBe(0);
  while (!text.endsWith('[complete]'))
    text = await reader.view(b, text.match(/cursor=(\S+)$/u)![1]);
  expect((await store.maintenanceState('w')).usage.get(a)?.reads).toBe(1);
  await expect(reader.write({ op: 'delete', path: a }, 'w')).rejects.toMatchObject({
    code: 'STASH_STALE_READ',
  });
  await expect(
    reader.write({ op: 'create', path: b, content: note(b) }, 'w'),
  ).rejects.toMatchObject({ code: 'STASH_ALREADY_EXISTS' });
  expect(decideResident(before, await memory.actual(), 'w', meter, config).kind).toBe('none');
  await writeFile(join(dir, c), note('无关编辑'));
  await store.rollback('w', r.id, validate);
  expect((await store.read('w', a))?.content).toBe(initial.get(a));
  expect((await store.read('w', b))?.content).toBe(initial.get(b));
  expect((await store.read('w', c))?.content).toBe(note('无关编辑'));
  expect(await reader.view(b)).not.toContain('Redirect:');
});

it('按展开后的规则逐行确认，包括经由笔记导入的变化；旧确认不可用于不同计划', async () => {
  const { dir, store, plan, apply, memory } = await fixture();
  await writeFile(join(dir, 'RULES.md'), '@notes/a.md\n结尾');
  const before = await memory.actual();
  const r = await plan([merge, { op: 'rule', content: '@notes/a.md\n新结尾' }]);
  expect(r.rules.length).toBeGreaterThan(1);
  await expect(apply(r, [r.rules[0]!.line])).rejects.toMatchObject({ code: 'STASH_READ_ONLY' });
  expect(await memory.actual()).toEqual(before);
  const revised = await store.plan(
    'w',
    r.id,
    { kind: 'propose', steps: [merge], seen: snapshotRevision(await store.snapshot('w')) },
    validate,
  );
  await expect(apply(r)).rejects.toMatchObject({ code: 'STASH_STALE_READ' });
  await apply(revised);
  expect(decideResident(before, await memory.actual(), 'w', meter, config).kind).toBe('rules');
  await writeFile(join(dir, a), note('手动修改'));
  await expect(store.rollback('w', r.id, validate)).rejects.toMatchObject({
    code: 'STASH_STALE_READ',
  });
  expect(await store.read('w', b)).toBeNull();
  expect(await readFile(join(dir, a), 'utf8')).toBe(note('手动修改'));
});

it('陈旧快照、超预算、凭据和无法创建的目录冲突在批次写盘前拒绝', async () => {
  const { dir, store, plan, apply } = await fixture();
  await expect(plan([{ op: 'rule', content: '长'.repeat(2000) }])).rejects.toMatchObject({
    code: 'STASH_BUDGET_EXCEEDED',
  });
  await expect(plan([{ op: 'rule', content: 'sk-' + 'x'.repeat(20) }])).rejects.toMatchObject({
    code: 'STASH_SECRET',
  });
  const stale = await plan([merge]);
  await writeFile(join(dir, c), note('已变化'));
  await expect(apply(stale)).rejects.toMatchObject({ code: 'STASH_STALE_READ' });
  expect(await store.read('w', b)).not.toBeNull();
  const r = await plan([
    {
      op: 'split',
      path: a,
      body: '主',
      description: '主',
      parts: [{ path: '/notes/x/part.md', body: '次', description: '次' }],
    },
  ]);
  await writeFile(join(dir, 'notes', 'x'), '障碍');
  await expect(apply(r)).rejects.toThrow();
  await expect(readFile(join(dir, '.batch.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await store.read('w', a))?.content).toBe(note(a));
});

it('从部分落盘的批次续写，重复打开不重复记账；未知版本不覆盖', async () => {
  const { store, dir, root } = await fixture();
  await store.observe('w');
  const id = group();
  const changes = [a, b].map((path) => ({
    v: 1,
    id: randomUUID(),
    workspaceId: 'w',
    path,
    before: memoryFile(note(path)),
    after: memoryFile(note('新')),
    timestamp: new Date().toISOString(),
    actor: id,
    callId: id,
    op: 'maintenance',
    group: id,
  }));
  await writeFile(join(dir, '.batch.json'), JSON.stringify({ v: 1, changes }));
  await writeFile(join(dir, '.pending.json'), JSON.stringify(changes[0]));
  await writeFile(join(dir, a), note('新'));
  await expect(store.snapshot('w', true)).rejects.toMatchObject({ code: 'STASH_LOCKED' });
  const reopened = new FileMemoryStore(root);
  await reopened.observe('w');
  await reopened.observe('w');
  expect((await reopened.journal('w')).filter((row) => row.group === id)).toHaveLength(2);
  await reopened.rollback('w', id, validate);
  expect(await readFile(join(dir, b), 'utf8')).toBe(note(b));
  await writeFile(join(dir, '.batch.json'), '{"v":2}');
  await expect(reopened.observe('w')).rejects.toThrow();
  expect(await readFile(join(dir, '.batch.json'), 'utf8')).toBe('{"v":2}');
});

it('折叠跨阈值才提示；整体清空释放别名；不改写未知版本的统计与草稿', async () => {
  const { store, dir, root, plan, apply, memory } = await fixture();
  const r = await plan([merge]);
  await apply(r);
  await store.clear('w', snapshotRevision(await store.snapshot('w')));
  expect(await store.aliases('w')).toEqual(new Map());
  const tiny = new WorkspaceMemory(store, 'w', 's', meter, { ...config, indexBudgetTokens: 2 });
  expect((await tiny.write({ op: 'create', path: a, content: note(a) }, '1')).text).toContain(
    FOLD_HINT,
  );
  expect((await tiny.write({ op: 'create', path: b, content: note(b) }, '2')).text).not.toContain(
    FOLD_HINT,
  );
  await writeFile(join(dir, '.stats.json'), '{"v":99}');
  await expect(memory.view(a)).rejects.toThrow();
  expect(await readFile(join(dir, '.stats.json'), 'utf8')).toBe('{"v":99}');
  const old = join(dir, '.plan-' + r.id + '.json');
  await writeFile(old, '{"v":99}');
  await expect(new FileMemoryStore(root).verifyMaintenance('w')).rejects.toThrow();
  expect(await readFile(old, 'utf8')).toBe('{"v":99}');
});

it('移动允许连续跳转；拒绝未完整读过语料的模型提案', async () => {
  const { plan, apply, store, memory } = await fixture();
  const id = group();
  await store.startPlan('w', id);
  const steps: PlanStep[] = [{ op: 'move', path: a, to: '/notes/sub/new.md' }];
  await expect(
    store.plan('w', id, { kind: 'propose', seen: null, steps }, validate),
  ).rejects.toMatchObject({ detail: { kind: 'maintenance-read' } });
  let out = await memory.view('/notes/', undefined, '/notes/', true);
  while (!out.endsWith('[complete]'))
    out = await memory.view('/notes/', out.match(/cursor=(\S+)$/u)![1], '/notes/', true);
  const first = await store.plan(
    'w',
    id,
    { kind: 'propose', seen: memory.corpusRevision, steps },
    validate,
  );
  await apply(first);
  const second = await plan([{ op: 'move', path: '/notes/sub/new.md', to: '/notes/final.md' }]);
  await apply(second);
  expect(await memory.view(a)).toContain('→ /notes/final.md');
  await expect(store.rollback('w', id, validate)).rejects.toMatchObject({
    code: 'STASH_STALE_READ',
  });
  await store.rollback('w', second.id, validate);
  expect(await memory.view(a)).toContain('→ /notes/sub/new.md');
});

it('单篇外部笔记格式损坏时仍可从记忆页修复', async () => {
  const { memory, store, dir } = await fixture();
  await writeFile(join(dir, a), '格式损坏');
  const file = (await store.read('w', a))!;
  await memory.editFromPage(a, note('修复'), file.revision);
  expect((await store.read('w', a))?.content).toBe(note('修复'));
});
