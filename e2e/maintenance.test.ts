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
    toolName: 'memory_view',
    toolArguments: JSON.stringify({ path: '/notes/' }),
  });
  const mock = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    toolName: 'stash_plan',
    toolArguments: JSON.stringify({ steps: JSON.stringify(steps) }),
  });
  const title = await startMockLlmServer({ sequence: ['success'], repeatLast: true });
  // 标题生成不消耗整理脚本；两个工具步骤只接收带工具的请求。
  let reads = 0;
  const relay = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const payload = Buffer.concat(chunks);
    const data = JSON.parse(payload.toString()) as { tools?: unknown[] };
    const destination = data.tools?.length ? (reads++ === 0 ? reader : mock) : title;
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
      expect(mock.requests.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(mock.requests[0]!.body)).toContain('事实 99');
      const body = reader.requests[0]!.body as { tools: { name: string }[] };
      expect(body.tools.map((t) => t.name)).toContain('stash_plan');
      expect(body.tools.map((t) => t.name)).not.toContain('memory_write');
      expect(
        JSON.stringify((mock.requests.at(-1)!.body as { messages: unknown[] }).messages.at(-1)),
      ).toContain('Proposal saved');
      const review = (await run({ op: 'review', id })).review!;
      expect(review.rules.length).toBe(2);
      expect((await page()).files.workspace).toEqual(before);
      await run({
        op: 'apply',
        id,
        revision: review.revision,
        confirmed: review.rules.map((r) => r.line),
      });
      const after = (await page()).files.workspace;
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
      expect((await page()).files.workspace).toEqual(before);
      for (const file of before)
        expect(await readFile(join(dir, file.path))).toEqual(Buffer.from(file.content));
    } finally {
      await host.close();
    }
  } finally {
    await new Promise<void>((done) => relay.close(() => done()));
    await title.close();
    await reader.close();
    await mock.close();
    await fixture.close();
  }
});
