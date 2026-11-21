import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { join, resolve } from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { startMockLlmServer, type MockLlmServerOptions } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';
import { foldLog } from '../packages/devtools/src/fold.ts';

const note = (v: string) => `---\ntype: finding\ndescription: ${v}\n---\n${v}`;

const call = (toolName: string, args: object): MockLlmServerOptions => ({
  sequence: ['tool_call_success'],
  toolName,
  toolArguments: JSON.stringify(args),
});

const ok = (successText: string): MockLlmServerOptions => ({ sequence: ['success'], successText });
const paper = '两张底单柜号相同';
const next = '接下来联系当班人';
const draft = '副本内的专用回读标记';

const publicPath = '/notes/screen.md',
  privatePath = './notes/case.md';

for (const scenario of [
  'manual',
  'overflow',
  'empty',
  'abandoned',
  'disabled',
  'rejected',
  'conflict',
] as const) {
  it('压缩前副本和原版交接：' + scenario, async () => {
    const f = await createHarnessFixture();
    const patch = join(f.root, 'compact.yml');
    const script: MockLlmServerOptions[] = [];
    const changes = ['manual', 'overflow', 'rejected', 'conflict'].includes(scenario);
    if (scenario === 'overflow') script.push({ sequence: ['context_overflow'] });
    if (changes)
      script.push(
        call('memory_write', { path: privatePath, op: 'create', content: note(draft) }),
        call('memory_view', { path: privatePath }),
        call('memory_write', {
          path: privatePath,
          op: 'edit',
          old: '\n' + draft,
          new: '\n' + paper,
        }),
        call('memory_write', { op: 'create', path: publicPath, content: note('公屏只显示柜号') }),
        call('stash_diff', {}),
        call('stash_submit', {}),
      );
    if (scenario === 'conflict') script.push(ok('跳过冲突'));
    if (scenario === 'empty') script.push(ok('没有要补记的'));
    if (scenario === 'abandoned')
      script.push(call('memory_write', { op: 'create', path: privatePath, content: note(draft) }), {
        sequence: ['max_tokens'],
      });
    const summaryIndex = script.length;
    script.push(ok(scenario === 'rejected' ? '过长摘要'.repeat(8000) : '交接：' + next));
    if (scenario === 'overflow') script.push(ok('继续工作'));
    const mocks = await Promise.all(script.map((o) => startMockLlmServer(o)));
    let index = 0,
      workspace = '';
    const relay = createServer(async (req, res) => {
      const i = index++,
        m = mocks[i];
      if (!m) {
        res.writeHead(400);
        res.end();
        return;
      }
      if (scenario === 'conflict' && i === 5)
        await writeFile(join(workspace, publicPath.slice(1)), note('人工同时修改'));
      const upstream = request(
        new URL(req.url!, m.baseURL),
        { method: req.method, headers: req.headers },
        (r) => {
          res.writeHead(r.statusCode!, r.headers);
          r.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(upstream);
    });
    relay.listen(0, '127.0.0.1');
    await once(relay, 'listening');
    const addr = relay.address();
    if (!addr || typeof addr === 'string') throw new Error('测试端口不可用');
    try {
      await writeFile(
        patch,
        `- id: stash\n  config:\n    compactionNotes: ${scenario !== 'disabled'}\n`,
      );
      await f.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
      await f.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
      const seedMock = await startMockLlmServer(ok('收到'));
      const seed = f.sdk(seedMock.baseURL, f.cwd, [patch]);
      const id = seed.session();
      try {
        await id.run(paper + '；' + next + '。' + '废弃样本。'.repeat(1300));
      } finally {
        await seed.close();
        await seedMock.close();
      }
      workspace = join(
        f.home,
        'memory',
        (await readdir(join(f.home, 'memory'), { withFileTypes: true })).find(
          (d) => d.isDirectory() && !d.name.startsWith('.'),
        )!.name,
      );
      if (scenario === 'conflict') await mkdir(join(workspace, 'notes'), { recursive: true });
      const sdk = f.sdk('http://127.0.0.1:' + addr.port, f.cwd, [patch]);
      try {
        const s = await sdk.resumeSession(id.id);
        const result = await s.run(scenario === 'overflow' ? '继续' : '/compact');
        expect(index).toBe(script.length);
        expect(result.finishReason).toBe(scenario === 'rejected' ? 'error' : 'completed');
        const last = JSON.stringify(mocks[summaryIndex]!.requests[0]!.body);
        expect(last).toContain(paper);
        expect(last).toContain(next);
        expect(last).toContain('## Next Step');
        expect(last).not.toContain(draft);
        expect(last).not.toContain('This is not a general memory cleanup');
        if (scenario !== 'disabled') {
          const m = mocks[scenario === 'overflow' ? 1 : 0]!.requests[0]!.body as {
            tools: { name: string }[];
          };
          expect(m.tools.map((t) => t.name)).toEqual([
            'memory_view',
            'memory_write',
            'stash_stage',
            'stash_diff',
            'stash_submit',
          ]);
        }
        if (changes) {
          const b = JSON.stringify(mocks[scenario === 'overflow' ? 3 : 2]!.requests[0]!.body);
          expect(b).toContain('[complete]');
          expect(b).toContain(draft);
        }
        await sdk.close();
        const live = (await foldLog(join(f.home, 'sessions'), id.id)).at(-1)?.files ?? {};
        if (changes && scenario !== 'conflict') {
          expect(live['/notes/case.md']?.content).toContain(paper);
          expect(live['/notes/case.md']?.content).not.toContain(next);
          expect(await readFile(join(workspace, publicPath.slice(1)), 'utf8')).toBe(
            note('公屏只显示柜号'),
          );
          const coldMock = await startMockLlmServer({
            sequence: ['tool_call_success', 'success'],
            toolName: 'memory_view',
            toolArguments: JSON.stringify({ path: privatePath }),
            repeatLast: true,
            successText: '好',
          });
          const cold = f.sdk(coldMock.baseURL, f.cwd, [patch]);
          try {
            await (await cold.resumeSession(id.id)).run('继续上一次的工作');
            const first = JSON.stringify(coldMock.requests[0]!.body);
            if (scenario === 'rejected') expect(first.includes(draft)).toBe(false);
            else expect(first.includes(draft)).toBe(true);
            // 原版拒绝摘要时保留旧索引；显式读取仍能取回已经提交的会话笔记。
            expect(
              JSON.stringify(coldMock.requests[1]!.body).includes('description: ' + draft),
            ).toBe(true);
            await cold.session().run('新会话');
            expect(JSON.stringify(coldMock.requests.at(-1)!.body)).toContain('公屏只显示柜号');
            expect(JSON.stringify(coldMock.requests.at(-1)!.body)).not.toContain(draft);
          } finally {
            await cold.close();
            await coldMock.close();
          }
        } else {
          expect(live).toEqual({});
          if (scenario === 'conflict')
            expect(await readFile(join(workspace, publicPath.slice(1)), 'utf8')).toBe(
              note('人工同时修改'),
            );
        }
      } finally {
        await sdk.close();
      }
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((done) => relay.close(() => done()));
      await Promise.all(mocks.map((m) => m.close()));
      await f.close();
    }
  });
}
