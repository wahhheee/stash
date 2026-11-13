import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { FileMemoryStore, memoryFile } from '../src/adapters/memory-store.ts';
import { WorkspaceMemory } from '../src/host/memory.ts';

const roots: string[] = [];
const meter = { estimate: (text: string) => Math.ceil(text.length / 4) };

const config = {
  rulesBudgetTokens: 1600,
  indexBudgetTokens: 1600,
  viewBudgetTokens: 256,
  externalRuleUpdates: 'next-request' as const,
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stash-memory-'));
  roots.push(root);
  const store = new FileMemoryStore(root);
  await store.ensure({ format: 1, id: 'w', path: root, title: '测试' });
  return {
    root,
    store,
    a: new WorkspaceMemory(store, 'w', 'a', meter, config),
    b: new WorkspaceMemory(new FileMemoryStore(root), 'w', 'b', meter, config),
  };
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('跨实例写入原子检查旧版本，日志保留修改和外部删除', async () => {
  const { root, store, a, b } = await fixture();
  await a.write({ path: '/RULES.md', op: 'create', content: '- 旧规则' }, '1');
  await a.view('/RULES.md');
  await b.view('/RULES.md');
  const results = await Promise.allSettled([
    a.write({ path: '/RULES.md', op: 'replace', content: '- 甲' }, '2'),
    b.write({ path: '/RULES.md', op: 'replace', content: '- 乙' }, '3'),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'STASH_STALE_READ' },
  });
  const journal = await store.journal('w');
  expect(journal).toHaveLength(2);
  expect(journal[1]!.before?.content).toBe('- 旧规则');
  await writeFile(join(root, 'w', 'RULES.md'), '- 编辑器');
  await a.actual();
  expect((await store.journal('w')).at(-1)).toMatchObject({
    actor: 'external',
    after: { content: '- 编辑器' },
  });
  await rm(join(root, 'w', 'RULES.md'));
  await a.actual();
  expect((await store.journal('w')).at(-1)?.after).toBeNull();
});

it('并入笔记的写入也检查规则预算，失败不改变文件或日志', async () => {
  const { store, a } = await fixture();
  const text = '---\ntype: custom\ndescription: 条件结论\n---\n短规则';
  await a.write({ path: '/notes/a.md', op: 'create', content: text }, '1');
  await a.write({ path: '/RULES.md', op: 'create', content: '@notes/a.md' }, '2');
  await a.view('/notes/a.md');
  await expect(
    a.write({ path: '/notes/a.md', op: 'replace', content: text + '长'.repeat(7000) }, '3'),
  ).rejects.toMatchObject({ code: 'STASH_BUDGET_EXCEEDED' });
  expect((await store.read('w', '/notes/a.md'))?.content).toBe(text);
  expect(await store.journal('w')).toHaveLength(2);
});

it('续读完整性、删除行、凭据与未来格式拒绝', async () => {
  const { root, store, a } = await fixture();
  const text = '---\ntype: lesson\ndescription: 一个结论\nextra: 保留\n---\n' + '正文'.repeat(1000);
  await a.write({ path: '/notes/a.md', op: 'create', content: text }, '1');
  let output = await a.view('/notes/a.md');
  await expect(a.write({ path: '/notes/a.md', op: 'archive' }, '2')).rejects.toMatchObject({
    code: 'STASH_STALE_READ',
  });
  while (output.includes('cursor='))
    output = await a.view('/notes/a.md', output.split('cursor=')[1]!);
  await a.write({ path: '/notes/a.md', op: 'archive' }, '3');
  expect((await a.actual()).index).toBe('');
  await expect(
    a.write({ path: '/RULES.md', op: 'create', content: 'sk-' + 'x'.repeat(30) }, '4'),
  ).rejects.toMatchObject({ code: 'STASH_SECRET' });
  expect(await store.read('w', '/RULES.md')).toBeNull();
  await writeFile(join(root, 'w', 'workspace.json'), '{"format":99}');
  await expect(store.ensure({ format: 1, id: 'w', path: root, title: '测试' })).rejects.toThrow();
  expect(await readFile(join(root, 'w', 'workspace.json'), 'utf8')).toBe('{"format":99}');
});

it('待提交记录在文件已替换或尚未替换时均可恢复，不重复日志', async () => {
  const { root, store } = await fixture();
  const change = {
    v: 1,
    id: 'pending',
    workspaceId: 'w',
    path: '/RULES.md',
    before: null,
    after: memoryFile('- 恢复'),
    actor: 'a',
    callId: '1',
    op: 'create',
    timestamp: new Date().toISOString(),
  };
  await writeFile(join(root, 'w', '.pending.json'), JSON.stringify(change));
  expect((await store.snapshot('w')).get('/RULES.md')).toBe('- 恢复');
  await writeFile(join(root, 'w', '.pending.json'), JSON.stringify(change));
  await store.snapshot('w');
  expect(await store.journal('w')).toHaveLength(1);
  await mkdir(join(root, 'w', 'notes'));
  await writeFile(join(root, 'w', 'notes', 'broken.md'), 'invalid');
  await expect(new WorkspaceMemory(store, 'w', 'a', meter, config).actual()).rejects.toMatchObject({
    code: 'STASH_INVALID_DATA',
  });
});

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { runNode, testEnvironment } from '../../devtools/src/harness.ts';

it('两个独立 Node 进程对同一版本写入，只有一个提交成功', async () => {
  const { root, store } = await fixture();
  const first = await store.write('w', '/RULES.md', '- 原文', null);
  const moduleUrl = pathToFileURL(resolve('packages/plugin/src/adapters/memory-store.ts')).href;
  const script =
    'const {FileMemoryStore}=await import(' +
    JSON.stringify(moduleUrl) +
    '); const [root,rev,text]=process.argv.slice(1); try {await new FileMemoryStore(root).write("w","/RULES.md",text,rev);console.log("committed")} catch(e) {console.log(e.code);process.exitCode=1}';
  const results = await Promise.allSettled(
    ['甲', '乙'].map((text) =>
      runNode(
        ['--import', 'tsx', '--input-type=module', '-e', script, root, first.after!.revision, text],
        testEnvironment(join(root, 'isolated-home')),
      ),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const failure = results.find((result) => result.status === 'rejected');
  expect(failure?.status === 'rejected' && String(failure.reason)).toContain('STASH_STALE_READ');
  expect(await store.journal('w')).toHaveLength(2);
});
