import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import Commands from '@deepseek-ai/dsh-commands';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import RemoteAccess from '@deepseek-ai/dsh-api-remote-access';
import { Peer } from '@deepseek-ai/dsh-client-connection';
import { SessionId } from '@deepseek-ai/dsh-session';
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit';
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { expect, it } from 'vitest';
import Stash from '../lib/index.js';
import { TYPERT } from '../lib/typert.host.js';
import { mountHistoryHost } from './history-host.ts';
import { createAssistantMessage } from '@deepseek-ai/dsh-llm';

it('真实 Cordis 命令、Remote、卸载重载与作用域清理', async () => {
  const ctx = new Context();
  const root = await mkdtemp(join(tmpdir(), 'stash-host-'));
  try {
    await mountAgentLoopTestDependencies(ctx);
    await mountHistoryHost(ctx, root);
    await ctx.plugin(TokenMeter);
    await ctx.plugin(Commands);
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(RemoteAccess);
    await ctx.plugin(Gateway);
    const harness = await mountAgentLoopTestHarness(ctx);
    const agent = await harness.create(SessionId('stash-test-session'));
    const baseline = renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }));
    const plugin = ctx.plugin(Stash, { memoryRoot: join(root, 'memory') });
    await plugin;
    const definition = ctx.typert.register(TYPERT);
    const peer = new Peer(ctx, { principal: { kind: 'owner' } });
    const invoke = (args: Record<string, unknown> = {}) =>
      ctx.typertGateway.invoke({ namespace: 'stash', method: 'getStatus', args, peer });
    expect(await invoke()).toMatchObject({ version: '0.4.0', phase: 4, memoryEnabled: true });
    await expect(invoke({ secret: 'unexpected' })).rejects.toThrow();
    const command = await ctx.commands.execute(
      agent,
      '/stash doctor --bundle',
      [],
      new AbortController().signal,
    );
    expect(command?.result).toMatchObject({
      kind: 'success',
      text: expect.stringContaining('bundle:'),
    });
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))).toContain(
      'Workspace memory',
    );
    expect(agent.session.snapshotEvents().some((e) => e.type === 'user/message')).toBe(false);
    const start = agent.session.append('turn/start', { turn: 1 });
    agent.session.append('step/start', { turn: 1, step: 1 });
    const message = createAssistantMessage({
      source: { provider: 'mock', model: 'mock' },
      content: [{ type: 'text', text: '已完成' }],
    });
    agent.session.append(
      'assistant/message',
      { turn: 1, step: 1, stream: [], message },
      { surfaceOp: 'append' },
    );
    agent.session.append('step/end', { turn: 1, step: 1 });
    const end = agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(
      await ctx.typertGateway.invoke({
        namespace: 'stash',
        method: 'getReference',
        args: { sessionId: agent.id, messageId: message.id },
        peer,
      }),
    ).toMatchObject({ id: agent.id, turn: 1, from: start.seq, to: end.seq });
    await expect(
      ctx.typertGateway.invoke({
        namespace: 'stash',
        method: 'getReference',
        args: { sessionId: agent.id, messageId: '' },
        peer,
      }),
    ).rejects.toThrow();
    await plugin.dispose();
    definition();
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: agent }))).toBe(baseline);
    expect(ctx.commands.find(agent, 'stash')).toBeUndefined();
    await expect(invoke()).rejects.toThrow();
    await ctx.plugin(Stash, { memoryRoot: join(root, 'memory') });
    expect(ctx.commands.find(agent, 'stash')).toBeDefined();
  } finally {
    await ctx.fiber.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

it('宿主支持 agent 作用域提示与工具，彼此不泄漏', async () => {
  const ctx = new Context();
  try {
    await mountAgentLoopTestDependencies(ctx);
    await ctx.plugin(TokenMeter);
    const harness = await mountAgentLoopTestHarness(ctx);
    const a = await harness.create(SessionId('scope-a'));
    const b = await harness.create(SessionId('scope-b'));
    const scoped = a.ctx.plugin({
      inject: ['systemPrompt', 'tools'],
      apply(scope) {
        scope.systemPrompt.section({
          name: 'stash-contract',
          order: 100,
          text: 'scoped-contract-text',
        });
        scope.tools.register({
          name: 'stash_contract',
          description: 'scope contract',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: { schema: { type: 'string' }, render: () => [{ type: 'text', text: 'ok' }] },
          execute: async () => 'ok',
        });
      },
    });
    await scoped;
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: a }))).toContain(
      'scoped-contract-text',
    );
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: b }))).not.toContain(
      'scoped-contract-text',
    );
    expect(ctx.tools.definitions(a).map((tool) => tool.name)).toContain('stash_contract');
    expect(ctx.tools.definitions(b).map((tool) => tool.name)).not.toContain('stash_contract');
    await scoped.dispose();
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: a }))).not.toContain(
      'scoped-contract-text',
    );
    expect(ctx.tools.definitions(a).map((tool) => tool.name)).not.toContain('stash_contract');
  } finally {
    await ctx.fiber.dispose();
  }
});
