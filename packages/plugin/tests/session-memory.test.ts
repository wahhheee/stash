import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { ToolCallId, createToolResultMessage } from '@deepseek-ai/dsh-llm';
import { MemoryAdapter } from '../src/adapters/memory-dsh.ts';
import { resolveConfig } from '../src/adapters/config.ts';
import { FileTraceSink } from '../src/adapters/trace.ts';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Sessions, { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session';
import Projections from '@deepseek-ai/dsh-session-projection';
import { expect, it } from 'vitest';
import { emptyCommits, commitFiles } from '@wahhheee/stash-core';
import {
  SessionMemoryStore,
  sessionMemoryProjection,
  commitMessage,
  foldSession,
  validateCommit,
} from '../src/adapters/session-memory.ts';
import { digest } from '../src/adapters/memory-store.ts';
import { WorkspaceMemory } from '../src/host/memory.ts';
import { mountHistoryHost } from './history-host.ts';
import { DshHistory, historyProjection } from '../src/adapters/history-dsh.ts';
import { HistoryBrowser } from '../src/host/history.ts';
import { foldLog } from '../../devtools/src/fold.ts';

const meter = { estimate: (s: string) => Math.ceil(s.length / 4) };

const config = {
  rulesBudgetTokens: 1600,
  indexBudgetTokens: 1600,
  viewBudgetTokens: 4000,
  externalRuleUpdates: 'next-request' as const,
};

it('真实宿主投影分叉独立、冷读与删除缓存后重建，搜索和跨会话只读一致', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stash-session-'));
  const boot = async () => {
    const ctx = new Context();
    await ctx.plugin(Sessions);
    await ctx.plugin(Projections);
    await mountHistoryHost(ctx, root);
    const projection = await ctx.sessionProjections.register(sessionMemoryProjection);
    const history = new DshHistory(
      ctx,
      await ctx.sessionProjections.register(historyProjection),
      projection,
    );
    return { ctx, projection, history };
  };
  let { ctx, projection, history } = await boot();
  try {
    const workspace = await ctx.workspaceRegistry.create(root);
    const source = ctx.sessions.create(SessionId('session-source'), { meta: { cwd: root } });
    const store = new SessionMemoryStore(source, () => projection.stateOf(source));
    const memory = new WorkspaceMemory(store, source.id, source.id, meter, config);
    store.begin('root');
    await memory.write({ path: '/RULES.md', op: 'create', content: '- 源规则' }, 'one');
    source.append('user/message', commitMessage(store.lastCommit()), { surfaceOp: 'append' });
    await memory.write(
      {
        path: '/notes/a.md',
        op: 'create',
        content: '---\ntype: lesson\ndescription: 分支结论\n---\n压测复用经验',
      },
      'two',
    );
    source.append('user/message', commitMessage(store.lastCommit()), { surfaceOp: 'append' });
    const fork = ctx.sessions.create(SessionId('session-fork'), {
      seed: source.snapshotEvents(),
      meta: { cwd: root, isSeeded: true },
      inheritedEventCount: SessionLogOffset(2),
    });
    await memory.write({ path: '/RULES.md', op: 'append', content: '\n- 后续源规则' }, 'three');
    source.append('user/message', commitMessage(store.lastCommit()), { surfaceOp: 'append' });
    expect(commitFiles(projection.stateOf(fork)).get('/RULES.md')).toBe('- 源规则');
    const forkStore = new SessionMemoryStore(fork, () => projection.stateOf(fork));
    const forkMemory = new WorkspaceMemory(forkStore, fork.id, fork.id, meter, config);
    await forkMemory.view('/RULES.md');
    await forkMemory.write({ path: '/RULES.md', op: 'replace', content: '- 分支规则' }, 'four');
    fork.append('user/message', commitMessage(forkStore.lastCommit()), { surfaceOp: 'append' });
    expect(commitFiles(projection.stateOf(source)).get('/RULES.md')).toContain('后续源规则');
    for (const session of [source, fork]) {
      const handle = await ctx.sessionPersistence.create(session.header, {
        inheritedEventCount: session.inheritedEventCount,
      });
      await handle.append(session.snapshotEvents());
      await handle.flush();
      await handle.close();
      await workspace.attachSession(session.id);
      await ctx.sessionProjectionCache.write(session);
    }
    await ctx.fiber.dispose();
    // 仅删除隔离测试目录中明确的缓存文件，验证日志是唯一正本。
    await rm(join(root, 'storage', 'session_projcache', 'sessions', source.id + '.json'));
    await rm(join(root, 'storage', 'session_projcache', 'sessions', fork.id + '.json'));
    ({ ctx, projection, history } = await boot());
    expect((await history.session(fork.id)).memory?.['/RULES.md']).toBe('- 分支规则');
    expect((await history.session(fork.id)).lineage?.source).toBe(source.id);
    const browser = new HistoryBrowser(history, workspace.id, fork.id, meter, 4000);
    expect(await browser.view({ path: '../source/RULES.md' })).toContain('Reference data only');
    expect(await browser.view({ path: '/sessions' })).toContain('notes: 1');
    expect(await browser.view({ path: '/sessions', query: '压测复用', all: true })).toContain(
      'dsh://session/session-source/notes/a.md',
    );
    const steps = await foldLog(join(root, 'sessions'), fork.id);
    expect(steps.at(-1)?.files['/RULES.md']?.content).toBe('- 分支规则');
    expect(ctx.sessions.list()).toHaveLength(0);
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('未知版本、坏哈希和未结算提交不会覆盖正本，通知重复不重复应用', async () => {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  try {
    const session = ctx.sessions.create(SessionId('session-staged'));
    const store = new SessionMemoryStore(session, () => foldSession(session.snapshotEvents()));
    const memory = new WorkspaceMemory(store, session.id, session.id, meter, config);
    store.begin('root');
    await memory.write({ path: '/RULES.md', op: 'create', content: '待提交' }, 'a');
    expect(await memory.view('/RULES.md')).toContain('待提交');
    store.settle('a', true, false);
    expect(store.state()).toEqual(emptyCommits());
    await memory.write({ path: '/RULES.md', op: 'create', content: '待丢弃' }, 'b');
    store.begin('another-root');
    expect(store.state()).toEqual(emptyCommits());
    const commit = {
      v: 1,
      id: randomUUID(),
      sessionId: session.id,
      path: '/RULES.md',
      content: '已提交',
      beforeRevision: null,
      revision: digest('已提交'),
    };
    expect(() => validateCommit({ ...commit, v: 2 })).toThrow();
    expect(() => validateCommit({ ...commit, content: '篡改' })).toThrow('哈希');
    session.append('user/message', commitMessage(validateCommit(commit)), { surfaceOp: 'append' });
    session.append('user/message', commitMessage(validateCommit(commit)), { surfaceOp: 'append' });
    expect(Object.keys(store.state().applied)).toHaveLength(1);
  } finally {
    await ctx.fiber.dispose();
  }
});

for (const subagentWrite of [false, true])
  it('子代理继承父会话当前规则，写入策略=' + subagentWrite, async () => {
    const root = await mkdtemp(join(tmpdir(), 'stash-subagent-'));
    const ctx = new Context();
    try {
      await mountAgentLoopTestDependencies(ctx);
      await mountHistoryHost(ctx, root);
      await ctx.plugin(TokenMeter);
      const harness = await mountAgentLoopTestHarness(ctx);
      const config = resolveConfig({ memoryRoot: join(root, 'memory'), subagentWrite });
      const adapter = new MemoryAdapter(
        ctx,
        config,
        new FileTraceSink(config.memoryRoot, 'off', 7),
      );
      const parent = await harness.create(SessionId('session-parent'), {}, { cwd: root });
      const inherited = validateCommit({
        v: 1,
        id: randomUUID(),
        sessionId: parent.id,
        path: '/RULES.md',
        content: '父会话规则',
        beforeRevision: null,
        revision: digest('父会话规则'),
      });
      parent.session.append('user/message', commitMessage(inherited), { surfaceOp: 'append' });
      const handle = await ctx.agents.create({
        sessionId: SessionId('session-child'),
        meta: { cwd: root, origin: 'subagent', parentSession: parent.id, delegationDepth: 1 },
      });
      try {
        const child = handle.agent;
        expect(
          (await adapter.actual(child, { rules: '', index: '', folded: false })).session,
        ).toMatchObject({ parentRules: '父会话规则', readOnly: !subagentWrite });
        const batch = await ctx.tools.execute({
          agent: child,
          signal: new AbortController().signal,
          calls: [
            {
              type: 'tool-call',
              id: ToolCallId('write-child'),
              name: 'memory_write',
              arguments: JSON.stringify({
                path: './RULES.md',
                op: 'create',
                content: '子代理规则',
              }),
            },
          ],
        });
        const result = batch.results[0]!.result;
        expect(Boolean(result.isError)).toBe(!subagentWrite);
        expect(JSON.stringify(result.content)).toContain(
          subagentWrite ? 'Wrote ./RULES.md' : 'STASH_UNSUPPORTED',
        );
      } finally {
        await handle.dispose();
      }
    } finally {
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

it('宿主裁剪替换保留结果元数据，原始提交只折叠一次且忽略失败结果', async () => {
  const ctx = new Context();
  await ctx.plugin(Sessions);
  try {
    const session = ctx.sessions.create(SessionId('session-trim'));
    const commit = validateCommit({
      v: 1,
      id: randomUUID(),
      sessionId: session.id,
      path: '/RULES.md',
      content: '保留的规则',
      beforeRevision: null,
      revision: digest('保留的规则'),
    });
    const original = session.append(
      'tool/result',
      {
        turn: 1,
        step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('call'),
          isError: false,
          content: [{ type: 'text', text: '完整工具结果' }],
        }),
        meta: { stashCommit: { ...commit } },
      },
      { surfaceOp: 'append' },
    );
    session.append(
      'tool/result',
      {
        ...original.data,
        message: { ...original.data.message, content: [{ type: 'text', text: '裁剪后' }] },
      },
      {
        surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
        sourceEventSeqs: [original.seq],
      },
    );
    session.append(
      'tool/result',
      {
        turn: 1,
        step: 2,
        message: createToolResultMessage({
          callId: ToolCallId('failed'),
          content: [],
          isError: true,
        }),
        meta: { stashCommit: { ...commit, v: 99 } },
      },
      { surfaceOp: 'append' },
    );
    const state = foldSession(session.snapshotEvents());
    expect(Object.keys(state.applied)).toHaveLength(1);
    expect(commitFiles(state).get('/RULES.md')).toBe('保留的规则');
    expect(session.surface.nodes).not.toContain(original.seq);
  } finally {
    await ctx.fiber.dispose();
  }
});
