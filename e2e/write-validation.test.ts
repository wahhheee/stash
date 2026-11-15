import { readFile, readdir } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';

it('真实 SDK 删除误传 content 后给出正确提示，省略后重试成功', async () => {
  const fixture = await createHarnessFixture();
  let endpoint = '';
  // 每轮切换本地 mock；宿主进程保持不变，以保留完整读取凭据。
  const relay = createServer((req, res) => {
    const upstream = request(
      new URL(req.url!, endpoint),
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
    req.pipe(upstream);
  });
  relay.listen(0, '127.0.0.1');
  await once(relay, 'listening');
  const address = relay.address();
  if (!address || typeof address === 'string') throw new Error('测试转发端口不可用');
  const host = fixture.sdk('http://127.0.0.1:' + address.port);
  const session = host.session();
  const call = async (toolName: string, args: Record<string, unknown>) => {
    const mock = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      successText: '已检查工具结果',
      toolName,
      toolArguments: JSON.stringify(args),
    });
    endpoint = mock.baseURL;
    try {
      await session.run('执行本次测试操作');
      return JSON.stringify(mock.requests.at(-1)!.body);
    } finally {
      await mock.close();
    }
  };
  try {
    await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
    await fixture.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
    const path = '/notes/test.md';
    const content = '---\ntype: lesson\ndescription: 测试结论\n---\n保留这段正文';
    await call('memory_write', { path, op: 'create', content });
    await call('memory_view', { path });
    const dirs = await readdir(join(fixture.home, 'memory'), { withFileTypes: true });
    const dir = join(
      fixture.home,
      'memory',
      dirs.find((d) => d.isDirectory() && !d.name.startsWith('.'))!.name,
    );
    const note = join(dir, 'notes', 'test.md');
    const journal = await readFile(join(dir, '.journal.jsonl'), 'utf8');
    const response = await call('memory_write', { path, op: 'delete', content: '' });
    expect(response).toContain('Omit that field and retry. No changes were made.');
    expect(response).toContain('does not accept');
    expect(response).not.toContain('Edit requires exactly');
    expect(await readFile(note, 'utf8')).toBe(content);
    expect(await readFile(join(dir, '.journal.jsonl'), 'utf8')).toBe(journal);
    await call('memory_write', { path, op: 'delete' });
    await expect(readFile(note, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readFile(join(dir, '.journal.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(
      2,
    );
  } finally {
    await host.close();
    await new Promise<void>((resolve, reject) =>
      relay.close((error) => (error ? reject(error) : resolve())),
    );
    await fixture.close();
  }
});
