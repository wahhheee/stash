import { createServer, request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';
import { foldLog } from '../packages/devtools/src/fold.ts';
import { forkFixture } from '../packages/devtools/src/fork-fixture.ts';

for (const mode of ['standard', 'ptc'])
  it(mode + ' 会话写入、分叉前缀、重启压缩和离线重放', async () => {
    const fixture = await createHarnessFixture();
    let endpoint = '';
    const relay = createServer((req, res) => {
      const upstream = request(
        new URL(req.url!, endpoint),
        { method: req.method, headers: req.headers },
        (reply) => {
          res.writeHead(reply.statusCode!, reply.headers);
          const suffix = randomUUID();
          let body = '';
          reply.setEncoding('utf8');
          reply.on('data', (chunk: string) => {
            body += chunk;
          });
          reply.on('end', () => res.end(body.replaceAll('mock-call-', suffix + '-')));
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
    if (!address || typeof address === 'string') throw new Error('端口不可用');
    const patch = join(fixture.root, 'ptc.patch.yml');
    await writeFile(
      patch,
      '- id: tool-executor-native\n  disabled: true\n- id: tool-executor-ptc\n  disabled: false\n',
    );
    const boot = () =>
      fixture.sdk('http://127.0.0.1:' + address.port, fixture.cwd, mode === 'ptc' ? [patch] : []);
    let host = boot();
    const source = host.session();
    const sourceId = source.id;
    const childId = 'session-stash-fork-' + mode;
    const invoke = async (
      id: string,
      tool?: string,
      args: Record<string, unknown> = {},
      program?: string,
    ) => {
      const mock = await startMockLlmServer({
        sequence: tool ? ['tool_call_success', 'success'] : ['success'],
        repeatLast: true,
        successText: '会话验收完成',
        ...(tool
          ? {
              toolName: mode === 'ptc' ? 'run_code' : tool,
              toolArguments: JSON.stringify(
                mode === 'ptc'
                  ? {
                      description: '验证当前会话记忆的读写行为',
                      code:
                        program ?? 'return await tools.' + tool + '(' + JSON.stringify(args) + ')',
                    }
                  : args,
              ),
            }
          : {}),
      });
      endpoint = mock.baseURL;
      try {
        await host.session(id).run('执行本次操作');
        return mock.requests.map((r) => r.body);
      } finally {
        await mock.close();
      }
    };
    try {
      await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
      await fixture.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
      const writes = await invoke(sourceId, 'memory_write', {
        path: './RULES.md',
        op: 'create',
        content: '- 分支限定规则',
      });
      expect(JSON.stringify(writes.at(-1))).toContain('Wrote ./RULES.md');
      const note = '---\ntype: lesson\ndescription: 分支试验结论\n---\n这个策略只用于本次试验';
      expect(
        JSON.stringify(
          (
            await invoke(sourceId, 'memory_write', {
              path: './notes/experiment.md',
              op: 'create',
              content: note,
            })
          ).at(-1),
        ),
      ).toContain('promote a copy');
      const duplicate = JSON.stringify(
        (
          await invoke(sourceId, 'memory_write', {
            path: './notes/experiment.md',
            op: 'create',
            content: note + '不应覆盖',
          })
        ).at(-1),
      );
      expect(duplicate).toContain('STASH_ALREADY_EXISTS');
      expect(duplicate).toContain('choose an appropriate update operation');
      const readOnly = JSON.stringify(
        (
          await invoke(sourceId, 'memory_write', {
            path: '../other/notes/experiment.md',
            op: 'create',
            content: note,
          })
        ).at(-1),
      );
      expect(readOnly).toContain('STASH_READ_ONLY');
      expect(readOnly).toContain('Other-session memory is read-only');
      expect(readOnly).not.toContain(
        'Use workspace or current-session rules/notes; sibling memory',
      );
      await host.close();
      expect(
        (await foldLog(join(fixture.home, 'sessions'), sourceId)).at(-1)?.files[
          '/notes/experiment.md'
        ]?.content,
      ).toBe(note);
      expect(
        (await foldLog(join(fixture.home, 'sessions'), sourceId)).at(-1)?.files['/RULES.md']
          ?.content,
      ).toBe('- 分支限定规则');
      await forkFixture(join(fixture.home, 'sessions'), sourceId, childId);
      host = boot();
      await host.resumeSession(sourceId);
      await host.resumeSession(childId);
      const parent = (await invoke(sourceId))[0] as { messages: unknown[] };
      const child = (await invoke(childId))[0] as { messages: unknown[] };
      expect(JSON.stringify(child)).toContain('<memory-position>');
      expect(JSON.stringify(child).match(/<memory-context>/gu)).toHaveLength(1);
      const prefix = parent.messages.slice(0, -1);
      expect(child.messages.slice(0, prefix.length)).toEqual(prefix);
      await invoke(childId, 'memory_write', {
        path: './RULES.md',
        op: 'append',
        content: '\n- 仅子分支追加',
      });
      expect(
        JSON.stringify((await invoke(sourceId, 'memory_view', { path: './RULES.md' })).at(-1)),
      ).not.toContain('仅子分支追加');
      expect(
        JSON.stringify(
          (await invoke(childId, 'memory_view', { path: '../' + sourceId + '/RULES.md' })).at(-1),
        ),
      ).toContain('Reference data only');
      const promoted = note.replace(
        'type: lesson',
        'type: lesson\nsources:\n  - dsh://session/' + sourceId + '/notes/experiment.md',
      );
      const promotion = JSON.stringify(
        (
          await invoke(childId, 'memory_write', {
            path: '/notes/promoted.md',
            op: 'create',
            content: promoted,
          })
        ).at(-1),
      );
      expect(promotion).toContain('Wrote /notes/promoted.md (workspace)');
      expect(
        JSON.stringify(
          (await invoke(sourceId, 'memory_view', { path: './notes/experiment.md' })).at(-1),
        ),
      ).toContain('这个策略只用于本次试验');
      const compactMock = await startMockLlmServer({
        sequence: ['success'],
        repeatLast: true,
        successText: '压缩摘要',
      });
      endpoint = compactMock.baseURL;
      try {
        await host.session(childId).run('/compact');
      } finally {
        await compactMock.close();
      }
      const compacted = JSON.stringify((await invoke(childId)).at(-1));
      expect(compacted).toContain('仅子分支追加');
      expect(compacted).toContain('./notes/experiment.md');
      expect(compacted).toContain('were compacted into a summary');
      if (mode === 'ptc') {
        const path = './notes/nested.md';
        const program =
          'await tools.memory_write(' +
          JSON.stringify({ path, op: 'create', content: note }) +
          ');' +
          'await tools.memory_write(' +
          JSON.stringify({ path, op: 'append', content: '\n同一根调用的追加' }) +
          ');' +
          'return await tools.memory_view(' +
          JSON.stringify({ path }) +
          ');';
        expect(
          JSON.stringify((await invoke(childId, 'memory_write', {}, program)).at(-1)),
        ).toContain('同一根调用的追加');
      }
      await host.close();
      if (mode === 'ptc')
        expect(
          (await foldLog(join(fixture.home, 'sessions'), childId)).at(-1)?.files['/notes/nested.md']
            ?.content,
        ).toContain('同一根调用的追加');
    } finally {
      await host.close();
      await new Promise<void>((done, reject) =>
        relay.close((error) => (error ? reject(error) : done())),
      );
      await fixture.close();
    }
  });
