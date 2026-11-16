import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { SessionId } from '@deepseek-ai/dsh-session';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { afterEach, expect, it, vi } from 'vitest';
import { StashError, commitFiles } from '@wahhheee/stash-core';
import { MemoryAdapter } from '../src/adapters/memory-dsh.ts';
import { resolveConfig } from '../src/adapters/config.ts';
import { FileTraceSink } from '../src/adapters/trace.ts';
import { mountHistoryHost } from './history-host.ts';

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanups.splice(0)) await close();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'stash-tool-errors-'));
  const ctx = new Context();
  cleanups.push(async () => {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await mountAgentLoopTestDependencies(ctx);
  await mountHistoryHost(ctx, root);
  await ctx.plugin(TokenMeter);
  const harness = await mountAgentLoopTestHarness(ctx);
  const config = resolveConfig({ memoryRoot: join(root, 'memory'), subagentWrite: true });
  const adapter = new MemoryAdapter(ctx, config, new FileTraceSink(config.memoryRoot, 'off', 7));
  const agent = await harness.create(SessionId('session-errors'), {}, { cwd: root });
  const memory = await adapter.memory(agent);
  const session = await adapter.sessionMemory(agent);
  let step = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    step++;
    const batch = await ctx.tools.execute({
      agent,
      signal: new AbortController().signal,
      log: { turn: 1, step },
      calls: [
        {
          type: 'tool-call',
          id: ToolCallId('error-test-' + step),
          name,
          arguments: JSON.stringify(args),
        },
      ],
    });
    const result = batch.results[0]!.result;
    return {
      failed: Boolean(result.isError),
      text: result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n'),
    };
  };
  const snapshot = async () => ({
    workspace: await adapter.store.snapshot(memory.workspaceId),
    journal: await adapter.store.journal(memory.workspaceId),
    session: session.store.state(),
  });
  return { ctx, adapter, agent, memory, session, call, snapshot };
}

const note = '---\ntype: lesson\ndescription: 条件结论\n---\n保留正文';

it('真实工具按目标解释只读，非法操作说明替代步骤，失败不修改记忆', async () => {
  const { call, snapshot } = await fixture();
  const before = await snapshot();
  for (const path of [
    '../other/notes/a.md',
    '/sessions/other/notes/a.md',
    'dsh://session/other/notes/a.md',
  ]) {
    const result = await call('memory_write', { path, op: 'create', content: note });
    expect(result.failed).toBe(true);
    expect(result.text).toContain('STASH_READ_ONLY');
    expect(result.text).toContain('Other-session memory is read-only');
    expect(result.text).not.toContain('This subagent');
  }
  for (const path of ['./log/1', '/sessions/other/log/1', 'dsh://session/other/1', '/sessions']) {
    const result = await call('memory_write', { path, op: 'create', content: note });
    expect(result.failed).toBe(true);
    expect(result.text).toContain('Session history is read-only');
    expect(result.text).not.toContain('This subagent');
  }
  for (const path of ['/RULES.md', './RULES.md']) {
    for (const op of ['archive', 'delete']) {
      const result = await call('memory_write', { path, op });
      expect(result.failed).toBe(true);
      expect(result.text).toContain('Rules cannot be');
      expect(result.text).toContain('replace with content: ""');
      expect(result.text).not.toContain('sibling');
    }
  }
  expect(await snapshot()).toEqual(before);
});

it('重复 create 明确提示更新操作，读取后重试 create 仍拒绝，按提示 replace 成功', async () => {
  const { call, snapshot, session } = await fixture();
  for (const path of ['/notes/a.md', './notes/a.md']) {
    expect((await call('memory_write', { path, op: 'create', content: note })).failed).toBe(false);
    const before = await snapshot();
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await call('memory_write', { path, op: 'create', content: note + '不应写入' });
      expect(result.failed).toBe(true);
      expect(result.text).toContain('STASH_ALREADY_EXISTS');
      expect(result.text).toContain('choose an appropriate update operation');
      expect(await snapshot()).toEqual(before);
      expect((await call('memory_view', { path })).failed).toBe(false);
    }
    expect(
      (await call('memory_write', { path, op: 'replace', content: note + '已更新' })).failed,
    ).toBe(false);
    expect((await call('memory_view', { path })).text).toContain('已更新');
  }
  expect(commitFiles(session.store.state()).get('/notes/a.md')).toBe(note + '已更新');
});

it('规则清空、归档和删除回执准确，会话删除不再声称笔记仍被索引', async () => {
  const { call, session } = await fixture();
  for (const path of ['/RULES.md', './RULES.md']) {
    await call('memory_write', { path, op: 'create', content: '规则' });
    await call('memory_view', { path });
    expect((await call('memory_write', { path, op: 'delete' })).text).toContain(
      'replace with content: ""',
    );
    expect((await call('memory_write', { path, op: 'replace', content: '' })).failed).toBe(false);
  }
  for (const path of ['/notes/a.md', './notes/a.md']) {
    const created = await call('memory_write', { path, op: 'create', content: note });
    expect(created.text.includes('promote a copy')).toBe(path.startsWith('./'));
    await call('memory_view', { path });
    const archived = await call('memory_write', { path, op: 'archive' });
    expect(archived.failed).toBe(false);
    expect(archived.text).toContain('Archived ' + path);
    expect(archived.text).toContain('existing rules imports remain active');
    expect(archived.text).not.toContain('promote');
    expect((await call('memory_view', { path })).text).toContain('status: archived');
    const deleted = await call('memory_write', { path, op: 'delete' });
    expect(deleted.failed).toBe(false);
    expect(deleted.text).toContain('Deleted ' + path);
    expect(deleted.text).not.toContain('promote');
    expect(deleted.text).not.toContain('index');
  }
  expect(commitFiles(session.store.state()).has('/notes/a.md')).toBe(false);
});

it('查询选项、时间和游标失败给出实际可执行的读取修正', async () => {
  const { call } = await fixture();
  for (const path of ['/notes/a.md', './notes/a.md', '../missing/notes/a.md']) {
    const result = await call('memory_view', { path, query: '结论' });
    expect(result.failed).toBe(true);
    expect(result.text).toContain('Rules and notes accept only path and cursor');
    expect(result.text).toContain('/sessions with query');
    expect(result.text).not.toContain('read-only');
  }
  for (const since of ['2026-11-16', '2026-02-30T00:00:00Z'])
    expect((await call('memory_view', { path: '/sessions', since })).text).toContain(
      'explicit timezone',
    );
  expect(
    (
      await call('memory_view', {
        path: '/sessions',
        since: '2026-11-17T00:00Z',
        until: '2026-11-16T00:00Z',
      })
    ).text,
  ).toContain('since must be earlier');
  expect((await call('memory_view', { path: '/sessions', query: '  ' })).text).toContain(
    'omit query to browse',
  );
  expect((await call('memory_view', { path: '/sessions/missing/log' })).text).toContain(
    'No session in this workspace',
  );
  expect((await call('memory_view', { path: './log/999999' })).text).toContain(
    'event range does not exist',
  );
  const history = await call('memory_view', { path: './log/turns', cursor: 'expired' });
  expect(history.text).toContain('omit cursor');
  expect(history.text).not.toContain('before changing it');
  await call('memory_write', { path: '/notes/a.md', op: 'create', content: note });
  const memory = await call('memory_view', { path: '/notes/a.md', cursor: 'expired' });
  expect(memory.text).toContain('same path without cursor');
  expect((await call('memory_view', { path: '/notes/a.md' })).text).toContain('[complete]');
});

it('工具边界不透传底层异常文字或用预算错误回显正文', async () => {
  const { adapter, call } = await fixture();
  const read = vi.spyOn(adapter.store, 'read');
  for (const error of [
    new Error('不应回显的底层正文'),
    new StashError('STASH_BUDGET_EXCEEDED', '不应回显的底层正文'),
  ]) {
    read.mockRejectedValueOnce(error);
    const result = await call('memory_view', { path: '/notes/a.md' });
    expect(result.failed).toBe(true);
    expect(result.text).not.toContain('不应回显');
  }
});
