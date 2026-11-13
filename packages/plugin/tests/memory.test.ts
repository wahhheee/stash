import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  stat,
  utimes,
  appendFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { FileMemoryStore, memoryFile } from '../src/adapters/memory-store.ts';
import { WorkspaceMemory } from '../src/host/memory.ts';
import type * as Fs from 'node:fs/promises';
import { residentSchema } from '../src/adapters/memory-records.ts';

const roots: string[] = [];

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof Fs>();
  return { ...fs, readFile: vi.fn(fs.readFile) };
});

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

it('重复观察复用正文和日志缓存，mtime、大小及删除分别失效', async () => {
  const { root, store } = await fixture();
  const path = join(root, 'w', 'RULES.md');
  const journalPath = join(root, 'w', '.journal.jsonl');
  await writeFile(path, '- 甲');
  await utimes(path, 1700000000, 1700000000);
  await store.observe('w');
  const reads = (target: string) =>
    vi.mocked(readFile).mock.calls.filter(([p]) => p === target).length;
  const initialReads = [reads(path), reads(journalPath)];
  await store.observe('w');
  await store.observe('w');
  expect([reads(path), reads(journalPath)]).toEqual(initialReads);
  expect(await store.journal('w')).toHaveLength(1);

  await writeFile(path, '- 乙');
  await utimes(path, 1700000001, 1700000001);
  expect((await store.observe('w')).files.get('/RULES.md')).toBe('- 乙');
  const stamp = await stat(path);
  await writeFile(path, '- 新增长规则');
  await utimes(path, stamp.atime, stamp.mtime);
  expect((await store.observe('w')).files.get('/RULES.md')).toBe('- 新增长规则');
  await rm(path);
  await store.observe('w');
  expect((await store.journal('w')).map((c) => c.after?.content ?? null)).toEqual([
    '- 甲',
    '- 乙',
    '- 新增长规则',
    null,
  ]);
});

it('同时间同大小外部修改允许扫描缓存命中，但写前版本校验仍拒绝覆盖', async () => {
  const { root, store, a } = await fixture();
  await a.write({ path: '/RULES.md', op: 'create', content: '- 甲' }, '1');
  const path = join(root, 'w', 'RULES.md');
  await utimes(path, 1700000000, 1700000000);
  await a.view('/RULES.md');
  await store.observe('w');
  await writeFile(path, '- 乙');
  await utimes(path, 1700000000, 1700000000);
  expect((await store.observe('w')).files.get('/RULES.md')).toBe('- 甲');
  await expect(
    a.write({ path: '/RULES.md', op: 'replace', content: '- 丙' }, '2'),
  ).rejects.toMatchObject({ code: 'STASH_STALE_READ' });
  expect(await readFile(path, 'utf8')).toBe('- 乙');
});

it('修改日志直接追加，损坏尾部只在存在匹配 pending 时恢复', async () => {
  const { root, store } = await fixture();
  const first = await store.write('w', '/RULES.md', '- 甲', null);
  const journalPath = join(root, 'w', '.journal.jsonl');
  const pendingPath = join(root, 'w', '.pending.json');
  const original = await readFile(journalPath);
  const change = {
    v: 1,
    id: 'interrupted',
    workspaceId: 'w',
    path: '/RULES.md',
    before: first.after,
    after: memoryFile('- 中文恢复'),
    timestamp: new Date().toISOString(),
    actor: 'a',
    callId: '2',
    op: 'replace',
  };
  const record = Buffer.from(JSON.stringify(change) + '\n');
  // 截断在 UTF-8 汉字内部也必须能按原始字节识别。
  const cut = record.indexOf(Buffer.from('中文恢复')) + 1;
  await appendFile(journalPath, record.subarray(0, cut));
  await expect(store.observe('w')).rejects.toThrow();
  await writeFile(pendingPath, JSON.stringify(change));
  expect((await store.observe('w')).files.get('/RULES.md')).toBe('- 中文恢复');
  expect(await readFile(journalPath)).toEqual(Buffer.concat([original, record]));
  await writeFile(pendingPath, JSON.stringify(change));
  await store.observe('w');
  expect(await store.journal('w')).toHaveLength(2);
  expect(await readFile(journalPath)).toEqual(Buffer.concat([original, record]));
});

it('恢复拒绝无关尾部、日志链损坏和外部覆盖，不截断已有数据', async () => {
  const { root, store } = await fixture();
  const first = await store.write('w', '/RULES.md', '- 甲', null);
  const journalPath = join(root, 'w', '.journal.jsonl');
  const pendingPath = join(root, 'w', '.pending.json');
  const original = await readFile(journalPath, 'utf8');
  const change = {
    v: 1,
    id: 'interrupted',
    workspaceId: 'w',
    path: '/RULES.md',
    before: first.after,
    after: memoryFile('- 乙'),
    timestamp: new Date().toISOString(),
    actor: 'a',
    callId: '2',
    op: 'replace',
  };
  await writeFile(pendingPath, JSON.stringify(change));
  const unrelated = original + '{"v":99';
  await writeFile(journalPath, unrelated);
  await expect(store.observe('w')).rejects.toThrow();
  expect(await readFile(journalPath, 'utf8')).toBe(unrelated);
  const broken = original.replace('"v":1', '"v":99') + JSON.stringify(change).slice(0, 20);
  await writeFile(journalPath, broken);
  await expect(store.observe('w')).rejects.toThrow();
  expect(await readFile(journalPath, 'utf8')).toBe(broken);
  await writeFile(journalPath, original);
  await writeFile(join(root, 'w', 'RULES.md'), '- 用户改写');
  await expect(store.observe('w')).rejects.toMatchObject({ code: 'STASH_STALE_READ' });
  expect(await readFile(journalPath, 'utf8')).toBe(original);
});

it('写入只返回简短结果，外部交错和新并入正文不被顺带确认', async () => {
  const { root, a, b } = await fixture();
  const original = '- 已知规则';
  const first = await a.write({ path: '/RULES.md', op: 'create', content: original }, '1', '');
  expect(first.trusted).toBe(true);
  expect(first.text).not.toContain(original);
  expect(first.text).not.toContain('<memory-context-update>');
  const note = '---\ntype: lesson\ndescription: 结论\n---\n规则引用正文';
  const ordinary = await a.write(
    { path: '/notes/a.md', op: 'create', content: note },
    '2',
    original,
  );
  expect(ordinary.trusted).toBe(true);
  expect(ordinary.text).not.toContain(original);
  await writeFile(join(root, 'w', 'RULES.md'), original + '\n- 用户手改');
  // 其他读操作已经记录了外部编辑，写入仍须依据会话的可见版本判定。
  await b.observe();
  const interleaved = await a.write(
    { path: '/RULES.md', op: 'append', content: '\n- 本次新增' },
    '3',
    original,
  );
  expect(interleaved.trusted).toBe(false);
  const repeated = await a.write(
    { path: '/RULES.md', op: 'append', content: '\n- 再次新增' },
    '4',
    original,
  );
  expect(repeated.trusted).toBe(false);
  const latest = (await a.observe()).state.rules;
  await b.write({ path: '/RULES.md', op: 'append', content: '\n- 其他会话' }, '5', latest);
  expect(
    (await a.write({ path: '/RULES.md', op: 'append', content: '\n- 继续' }, '6', latest)).trusted,
  ).toBe(false);
  const imported = await a.write(
    { path: '/RULES.md', op: 'append', content: '\n@notes/a.md' },
    '7',
    (await a.observe()).state.rules,
  );
  expect(imported.trusted).toBe(false);
  expect(imported.text).not.toContain('规则引用正文');
  const legacy = { v: 1, workspaceId: 'w', kind: 'write', state: first.state };
  expect(residentSchema.parse(legacy)).toEqual(legacy);
  expect(residentSchema.parse({ ...legacy, trusted: false }).trusted).toBe(false);
});
