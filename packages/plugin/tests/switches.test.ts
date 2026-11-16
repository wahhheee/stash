import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import { ToolCallId, createSystemMessage } from '@deepseek-ai/dsh-llm';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { afterEach, expect, it } from 'vitest';
import { DEFAULT_SWITCHES, renderResident } from '@wahhheee/stash-core';
import { MemoryAdapter } from '../src/adapters/memory-dsh.ts';
import { MemoryPage } from '../src/adapters/memory-page.ts';
import { resolveConfig } from '../src/adapters/config.ts';
import { FileTraceSink } from '../src/adapters/trace.ts';
import { mountHistoryHost } from './history-host.ts';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function fixture(enabled = true) {
  const root = await mkdtemp(join(tmpdir(), 'stash-switch-'));
  const ctx = new Context();
  cleanup.push(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await mountAgentLoopTestDependencies(ctx);
  await mountHistoryHost(ctx, root);
  await ctx.plugin(TokenMeter);
  const harness = await mountAgentLoopTestHarness(ctx);
  const config = resolveConfig({
    enabled,
    memoryRoot: join(root, 'memory'),
    viewBudgetTokens: 256,
  });
  const adapter = new MemoryAdapter(ctx, config, new FileTraceSink(config.memoryRoot, 'off', 7));
  const agent = await harness.create(SessionId('session-switch'), {}, { cwd: root });
  const target = { kind: 'session' as const, id: agent.id };
  const start = () =>
    agent.session.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage('test') },
      { surfaceOp: 'append' },
    );
  const page = new MemoryPage(adapter);
  let call = 0;
  const selection = { provider: 'mock', model: 'mock' };
  const admitted = () =>
    ctx.tools.resolve({ agent, signal: new AbortController().signal, modelSelection: selection });
  const execute = async (name: string, args: object) => {
    const toolSet = await admitted();
    try {
      const batch = await ctx.tools.execute({
        agent,
        toolSet,
        signal: new AbortController().signal,
        log: { turn: 1, step: ++call },
        calls: [
          {
            type: 'tool-call',
            id: ToolCallId('test-' + call),
            name,
            arguments: JSON.stringify(args),
          },
        ],
      });
      return JSON.stringify(batch.results[0]!.result);
    } finally {
      toolSet.dispose();
    }
  };
  return { root, ctx, harness, agent, target, page, adapter, admitted, execute, start };
}

it('首请求前多次切换不写日志，工具和说明按最终设置；中途关闭保留声明并拒绝工具', async () => {
  const { ctx, agent, target, page, admitted, execute } = await fixture();
  const before = agent.session.snapshotEvents();
  for (const enabled of [false, true, false])
    await page.change(target, {
      op: 'switches',
      scope: 'session',
      value: { ...DEFAULT_SWITCHES, enabled },
    });
  expect(agent.session.snapshotEvents()).toEqual(before);
  const off = await admitted();
  expect(ctx.tools.definitions(agent, off)).toHaveLength(0);
  expect(
    renderPrompt(await ctx.systemPrompt.assemble({ scope: agent, toolSet: off })),
  ).not.toContain('Workspace memory');
  off.dispose();
  await page.change(target, { op: 'switches', scope: 'session', value: DEFAULT_SWITCHES });
  const on = await admitted();
  expect(ctx.tools.definitions(agent, on).map((t) => t.name)).toContain('memory_write');
  on.dispose();
  await page.change(target, {
    op: 'switches',
    scope: 'session',
    value: { ...DEFAULT_SWITCHES, enabled: false },
  });
  const retained = await admitted();
  expect(ctx.tools.definitions(agent, retained).map((t) => t.name)).toContain('memory_view');
  retained.dispose();
  expect(await execute('memory_view', { path: '/' })).toContain('STASH_DISABLED');
});

it('全局关闭压过会话开启，界面仍允许用户维护内容', async () => {
  const { page, target, adapter, agent, admitted, ctx } = await fixture(false);
  await adapter.switches.set(
    { kind: 'session', id: agent.id },
    { ...DEFAULT_SWITCHES, enabled: true },
  );
  const tools = await admitted();
  expect(ctx.tools.definitions(agent, tools)).toHaveLength(0);
  tools.dispose();
  await expect(
    page.change(target, { op: 'switches', scope: 'session', value: DEFAULT_SWITCHES }),
  ).rejects.toMatchObject({ code: 'STASH_DISABLED' });
  expect(
    (
      await page.change(target, {
        op: 'save',
        scope: 'workspace',
        path: '/RULES.md',
        content: '用户规则',
        expected: null,
      })
    ).files.workspace[0]?.content,
  ).toBe('用户规则');
});

it('空白会话拒绝编辑且不污染日志，活动维护时段仍可编辑工作区', async () => {
  const { page, target, agent, start } = await fixture();
  const before = agent.session.snapshotEvents();
  await expect(
    page.change(target, {
      op: 'save',
      scope: 'session',
      path: '/RULES.md',
      content: '尚未开始',
      expected: null,
    }),
  ).rejects.toMatchObject({ code: 'STASH_UNSUPPORTED' });
  expect(agent.session.snapshotEvents()).toEqual(before);
  expect((await page.read(target)).sessionEditable).toBe(false);
  start();
  let release!: () => void;
  const held = agent.runMaintenance(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  try {
    const result = await page.change(target, {
      op: 'save',
      scope: 'workspace',
      path: '/RULES.md',
      content: '工作区仍可编辑',
      expected: null,
    });
    expect(result.files.workspace[0]?.content).toBe('工作区仍可编辑');
    await expect(
      page.change(target, {
        op: 'save',
        scope: 'session',
        path: '/RULES.md',
        content: '不能交错',
        expected: null,
      }),
    ).rejects.toThrow();
    expect((await page.read(target)).files.session).toEqual([]);
  } finally {
    release();
    await held;
  }
});

it('界面编辑、提升、冲突及清空保持提交投影与修改历史，开关重读不丢失', async () => {
  const { root, page, target, adapter, agent, execute, start } = await fixture();
  start();
  const note = '---\ntype: lesson\ndescription: 结论\n---\n正文';
  const created = await page.change(target, {
    op: 'save',
    scope: 'session',
    path: '/notes/a.md',
    content: note,
    expected: null,
  });
  const original = created.files.session[0]!;
  expect((await (await adapter.history).memorySnapshot(agent.id)).files.get(original.path)).toBe(
    note,
  );
  await expect(
    page.change(target, {
      op: 'save',
      scope: 'session',
      path: original.path,
      content: note + 'x',
      expected: '0'.repeat(64),
    }),
  ).rejects.toMatchObject({ code: 'STASH_STALE_READ' });
  expect(
    await execute('memory_write', { path: './notes/a.md', op: 'replace', content: note }),
  ).toContain('STASH_STALE_READ');
  const promoted = await page.change(target, {
    op: 'promote',
    path: original.path,
    destination: original.path,
    expected: original.revision,
  });
  expect(promoted.files.workspace[0]?.content).toContain(
    'dsh://session/' + agent.id + original.path,
  );
  expect(promoted.files.session[0]?.content).toBe(note);
  const settings = { ...DEFAULT_SWITCHES, enabled: false };
  await page.change(target, { op: 'switches', scope: 'workspace', value: settings });
  await adapter.store.ensure({ format: 1, id: promoted.workspaceId, title: 'changed', path: root });
  expect(await adapter.store.getSwitches(promoted.workspaceId)).toEqual(settings);
  const cleared = await page.change(target, {
    op: 'clear',
    scope: 'session',
    expected: promoted.revisions.session,
    confirm: true,
  });
  expect(cleared.files.session).toEqual([]);
  expect(cleared.files.workspace).toHaveLength(1);
  await expect(
    page.change(target, {
      op: 'clear',
      scope: 'workspace',
      expected: '0'.repeat(64),
      confirm: true,
    }),
  ).rejects.toMatchObject({ code: 'STASH_STALE_READ' });
  const empty = await page.change(target, {
    op: 'clear',
    scope: 'workspace',
    expected: cleared.revisions.workspace,
    confirm: true,
  });
  expect(empty.files.workspace).toEqual([]);
  expect(await adapter.store.journal(empty.workspaceId)).toHaveLength(2);
  const metadata = join(adapter.store.directory(empty.workspaceId), 'workspace.json');
  const text = await readFile(metadata, 'utf8');
  await writeFile(metadata, text.replace('"v":1', '"v":99'));
  await expect(adapter.store.getSwitches(empty.workspaceId)).rejects.toThrow();
});

it('只读约束模型，干净快照只含会话内容；分叉复制开关且之后独立', async () => {
  const { page, target, adapter, agent, ctx, root, execute, start } = await fixture();
  start();
  await page.change(target, {
    op: 'save',
    scope: 'workspace',
    path: '/RULES.md',
    content: '工作区独有标识',
    expected: null,
  });
  await page.change(target, {
    op: 'save',
    scope: 'session',
    path: '/RULES.md',
    content: '会话独有标识',
    expected: null,
  });
  const value = {
    ...DEFAULT_SWITCHES,
    inheritWorkspace: false,
    writable: false,
    discoverable: false,
  };
  await page.change(target, { op: 'switches', scope: 'session', value });
  const memory = await adapter.memory(agent);
  const rendered = renderResident(
    memory.workspaceId,
    await adapter.actual(agent, await memory.actual()),
  );
  expect(rendered).toContain('会话独有标识');
  expect(rendered).not.toContain('工作区独有标识');
  expect((await adapter.command(agent, 'status'))?.text).toContain('可写：false');
  expect(
    await execute('memory_write', { op: 'append', path: './RULES.md', content: '变化' }),
  ).toContain('STASH_READ_ONLY');
  const seed = agent.session.snapshotEvents();
  const fork = await ctx.agents.create({
    sessionId: SessionId('session-fork'),
    seed,
    inheritedEventCount: SessionLogOffset(seed.length),
    meta: { cwd: root, isSeeded: true },
  });
  expect(await adapter.switches.get({ kind: 'session', id: fork.agent.id })).toEqual(value);
  await page.change(target, { op: 'switches', scope: 'session', value: DEFAULT_SWITCHES });
  expect(await adapter.switches.get({ kind: 'session', id: fork.agent.id })).toEqual(value);
  await fork.dispose();
});

it('隐私变化撤销已有分页，显式引用仍可读取私有会话', async () => {
  const { page, target, adapter, agent, harness, root, execute } = await fixture();
  const other = await harness.create(SessionId('session-private'), {}, { cwd: root });
  other.session.append(
    'system/message',
    { turn: 1, step: 1, message: createSystemMessage('test') },
    { surfaceOp: 'append' },
  );
  await page.change(
    { kind: 'session', id: other.id },
    {
      op: 'save',
      scope: 'session',
      path: '/notes/a.md',
      content: '---\ntype: fact\ndescription: 内容\n---\n' + '唯一私密内容'.repeat(300),
      expected: null,
    },
  );
  const first = await execute('memory_view', { path: '/sessions/' + other.id + '/notes/a.md' });
  const cursor = /cursor=([a-f0-9-]+)/u.exec(first)?.[1];
  expect(cursor).toBeDefined();
  await adapter.switches.set(
    { kind: 'session', id: other.id },
    { ...DEFAULT_SWITCHES, discoverable: false },
  );
  expect(
    await execute('memory_view', { path: '/sessions/' + other.id + '/notes/a.md', cursor }),
  ).toContain('STASH_STALE_READ');
  expect(await execute('memory_view', { path: '/sessions' })).not.toContain(other.id);
  expect(
    await execute('memory_view', { path: 'dsh://session/' + other.id + '/notes/a.md' }),
  ).toContain('唯一私密内容');
  expect((await page.read(target)).sessionId).toBe(agent.id);
});
