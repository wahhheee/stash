import { randomUUID } from 'node:crypto';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';
import { startWebHost } from '../packages/devtools/src/web-host.ts';
import type {
  MaintenanceAction,
  MaintenanceData,
} from '../packages/plugin/src/adapters/maintenance-schema.ts';
import type { MemoryPageData } from '../packages/plugin/src/page-types.ts';
import { gateway } from './gateway.ts';

it('独立宿主会话在百篇笔记中提出合并、拆分及规则计划；确认、重定向和回滚贯穿 Gateway', async () => {
  const fixture = await createHarnessFixture();
  const path = (i: number) => `/notes/n${i}.md`;
  const steps = [
    {
      op: 'merge',
      path: path(0),
      from: [path(1)],
      description: '先检查工作区再提交',
      body: '先检查。',
    },
    {
      op: 'split',
      path: path(2),
      description: '测试用隔离目录',
      body: '测试隔离。',
      parts: [{ path: '/notes/source.md', description: '来源保留原文', body: '保留原文。' }],
    },
    { op: 'rule', content: '规则甲\n规则乙' },
  ];
  const reader = await startMockLlmServer({
    sequence: ['tool_call_success'],
    repeatLast: true,
    toolName: 'memory_view',
    toolArguments: JSON.stringify({ path: '/notes/' }),
  });
  const tool = (toolName: string, args: object) =>
    startMockLlmServer({
      sequence: ['tool_call_success'],
      repeatLast: true,
      toolName,
      toolArguments: JSON.stringify(args),
    });
  const merge = await tool('stash_stage', steps[0]!),
    split = await tool('stash_stage', steps[1]!);
  const write = await tool('memory_write', {
    op: 'create',
    path: '/RULES.md',
    content: '规则甲\n规则乙',
  });
  const reread = await tool('memory_view', { path: '/RULES.md' }),
    diff = await tool('stash_diff', {}),
    submit = await tool('stash_submit', {});
  const revise = await tool('memory_write', {
    op: 'edit',
    path: '/RULES.md',
    old: '规则乙',
    new: '规则乙（仅发布时）',
  });
  const direct = await tool('memory_write', {
    op: 'create',
    path: '/notes/direct.md',
    content: '---\ntype: fact\ndescription: 普通会话写入检查\n---\n普通会话不可直接写。',
  });
  const title = await startMockLlmServer({ sequence: ['success'], repeatLast: true });
  // 只有整理工具请求推进脚本；标题生成不占用步骤。
  let reads = 0;
  const relay = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks);
    const data = JSON.parse(payload.toString()) as { tools?: unknown[] };
    const sequence = [
      reader,
      merge,
      split,
      write,
      reread,
      diff,
      submit,
      title,
      revise,
      title,
      diff,
      submit,
      title,
      reader,
      write,
      diff,
      submit,
      title,
      direct,
      title,
    ];
    const destination = data.tools?.length ? (sequence[reads++] ?? title) : title;
    const upstream = request(
      new URL(req.url!, destination.baseURL),
      { method: req.method, headers: req.headers },
      (reply) => {
        res.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502);
      res.end();
    });
    upstream.end(payload);
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const address = relay.address();
  if (!address || typeof address === 'string') throw new Error('测试端口不可用');
  try {
    await fixture.cli('--profile', 'web-test', '--from-default-profile', 'web', '--dump-config');
    await fixture.cli('plugin', '--profile', 'web-test', 'add', resolve('packages/plugin'));
    const host = await startWebHost(fixture.home, {
      ...fixture.env,
      DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + address.port,
    });
    try {
      const invoke = await gateway(host.url);
      const { sessionId } = await invoke<{ sessionId: string }>('session/create', {
        request: { cwd: fixture.cwd },
      });
      const target = { kind: 'session', id: sessionId };
      const page = () => invoke<MemoryPageData>('stash/getMemory', { target });
      const initial = await page();
      const dir = join(fixture.home, 'memory', initial.workspaceId);
      await mkdir(join(dir, 'notes'), { recursive: true });
      for (let i = 0; i < 100; i++)
        await writeFile(
          join(dir, path(i)),
          `---\r\ntype: fact\r\ndescription: ${i < 2 ? '提交' : i === 2 ? '测试与来源' : '事实 ' + i}\r\nsources: [ref-${i}]\r\n---\r\n${i === 2 ? '测试隔离。保留原文。' : i < 2 ? '先检查。' : '事实 ' + i}\r\n`,
        );
      const before = (await page()).files.workspace;
      const run = (action: MaintenanceAction) =>
        invoke<MaintenanceData>('stash/maintenance', { target, action });
      const requestId = randomUUID();
      const started = await run({ op: 'start', requestId });
      expect((await run({ op: 'start', requestId })).started).toBe(started.started);
      expect(started.health.notes).toBe(100);
      const id = started.started!;
      expect(id).not.toBe(sessionId);
      await invoke('session/wait', { request: { sessionId: id, timeoutMs: 15000 } });
      expect(JSON.stringify(merge.requests[0]!.body)).toContain('事实 99');
      const body = reader.requests[0]!.body as { tools: { name: string }[] };
      expect(body.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          'memory_view',
          'memory_write',
          'stash_stage',
          'stash_diff',
          'stash_submit',
        ]),
      );
      expect(body.tools.map((t) => t.name)).not.toContain('stash_plan');
      expect(JSON.stringify(body)).toContain('stop before submission');
      expect(JSON.stringify(body)).toContain('Mode: REVIEW');
      expect(JSON.stringify(body)).not.toContain(
        'This is a read-only workspace maintenance session',
      );
      expect(JSON.stringify(submit.requests[0]!.body)).toContain('规则乙');
      const first = (await run({ op: 'review', id })).review!;
      const follow = async (text: string) => {
        await invoke('session/prompt', {
          request: {
            sessionId: id,
            requestId: randomUUID(),
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
        });
        await invoke('session/wait', { request: { sessionId: id, timeoutMs: 15000 } });
      };
      await follow('第二条规则补上适用条件，先不要提交。');
      expect((await run({ op: 'inspect' })).runs.map((r) => r.status)).toEqual(['editing']);
      await expect(
        run({ op: 'apply', id, revision: first.revision, confirmed: [1, 2] }),
      ).rejects.toThrow(/固定版本/);
      expect((await page()).files.workspace).toEqual(before);
      await follow('检查最终差异并提交。');
      const review = (await run({ op: 'review', id })).review!;
      expect(review.revision).not.toBe(first.revision);
      expect(review.rules.at(-1)?.after).toContain('仅发布时');
      expect(review.rules.length).toBe(2);
      const archive = (op: 'archiveSession' | 'unarchiveSession') =>
        invoke('workspace/' + op, { request: { sessionId: id } });
      await archive('archiveSession');
      expect((await run({ op: 'inspect' })).runs).toEqual([]);
      await expect(run({ op: 'start', requestId })).rejects.toThrow(/已归档/);
      await expect(run({ op: 'review', id })).rejects.toThrow(/已归档/);
      await expect(
        run({ op: 'apply', id, revision: review.revision, confirmed: [1, 2] }),
      ).rejects.toThrow(/已归档/);
      await archive('unarchiveSession');
      expect((await run({ op: 'review', id })).review).toEqual(review);
      expect((await run({ op: 'discard', id })).runs).toEqual([]);
      expect((await run({ op: 'discard', id })).runs).toEqual([]);
      await archive('unarchiveSession');
      expect((await page()).files.workspace).toEqual(before);
      await run({
        op: 'apply',
        id,
        revision: review.revision,
        confirmed: review.rules.map((r) => r.line),
      });
      const after = (await page()).files.workspace;
      await expect(run({ op: 'discard', id })).rejects.toThrow(/已应用/);
      await archive('archiveSession');
      expect((await run({ op: 'inspect' })).runs).toContainEqual({
        id,
        mode: 'review',
        status: 'applied',
        archived: true,
      });
      expect(after.some((f) => f.path === path(1))).toBe(false);
      expect(after.find((f) => f.path === path(0))?.note?.form.sources).toEqual(['ref-0', 'ref-1']);
      expect(after.find((f) => f.path === '/notes/source.md')?.note?.form.sources).toEqual([
        'ref-2',
      ]);
      const cmd = (line: string) =>
        invoke<{ result: { kind: string; text: string } }>('commands/execute', {
          agentId: sessionId,
          line,
          submittedAttachments: [],
        });
      expect((await cmd('/stash health')).result.text).toContain('100');
      expect((await cmd('/stash rollback ' + id)).result.kind).toBe('success');
      expect((await run({ op: 'inspect' })).runs).toContainEqual({
        id,
        mode: 'review',
        status: 'reverted',
        archived: true,
      });
      expect((await page()).files.workspace).toEqual(before);
      for (const file of before)
        expect(await readFile(join(dir, file.path))).toEqual(Buffer.from(file.content));

      // 普通会话只能读，用户仍可针对一次整理单独授权自动应用。
      expect(
        await invoke('stash/mutateMemory', {
          target,
          request: {
            id: randomUUID(),
            action: {
              op: 'switches',
              scope: 'workspace',
              value: { ...initial.workspace, writable: false },
            },
          },
        }),
      ).toMatchObject({ ok: true });
      const switches = await page();
      expect(switches.effective.writable).toBe(false);
      const auto = (await run({ op: 'start', requestId: randomUUID(), mode: 'auto' })).started!;
      await invoke('session/wait', { request: { sessionId: auto, timeoutMs: 15000 } });
      expect((await run({ op: 'inspect' })).runs).toContainEqual({
        id: auto,
        mode: 'auto',
        status: 'applied',
      });
      expect((await page()).files.workspace.find((f) => f.path === '/RULES.md')?.content).toBe(
        '规则甲\n规则乙',
      );
      await invoke('session/prompt', {
        request: {
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text: '记一条测试笔记。' }],
        },
      });
      await invoke('session/wait', { request: { sessionId, timeoutMs: 15000 } });
      expect(JSON.stringify(title.requests.at(-1)!.body)).toContain('STASH_READ_ONLY');
      const final = await page();
      expect(final.workspace).toEqual(switches.workspace);
      expect(final.session).toEqual(switches.session);
      expect(final.files.workspace.some((f) => f.path === '/notes/direct.md')).toBe(false);
      await run({ op: 'rollback', id: auto });
      expect((await page()).files.workspace).toEqual(before);
    } finally {
      await host.close();
    }
  } finally {
    await new Promise<void>((done) => relay.close(() => done()));
    await title.close();
    await reader.close();
    await Promise.all(
      [merge, split, write, reread, diff, submit, revise, direct].map((m) => m.close()),
    );
    await fixture.close();
  }
});
