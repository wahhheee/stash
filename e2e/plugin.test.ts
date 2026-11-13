import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture, runNode } from '../packages/devtools/src/harness.ts';
import { reconcile } from '../packages/devtools/src/reconcile.ts';

it('真实 SDK 工具写入、外部编辑、跨会话和压缩恢复', async () => {
  const fixture = await createHarnessFixture();
  const mock = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'],
    repeatLast: true,
    successText: 'stash e2e ok',
    toolName: 'memory_write',
    toolArguments: JSON.stringify({
      path: '/RULES.md',
      op: 'create',
      content: '- 提交信息使用简体中文。',
    }),
  });
  try {
    await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
    await fixture.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
    const harness = fixture.sdk(mock.baseURL);
    const sessionIds: string[] = [];
    let workspaceId = '';
    try {
      const session = harness.session();
      sessionIds.push(session.id);
      expect((await session.run('记住：以后提交信息使用简体中文。')).finalResponse).toBe(
        'stash e2e ok',
      );
      const first = JSON.stringify(mock.requests[0]!.body);
      expect(first).toContain('<memory-context>');
      expect(first).toContain('memory_view');
      expect(first).toContain('memory_write');
      const second = JSON.stringify(mock.requests[1]!.body);
      expect(second).toContain('Wrote /RULES.md');
      expect(second.match(/<memory-context>/gu)).toHaveLength(1);
      const dirs = await readdir(join(fixture.home, 'memory'), { withFileTypes: true });
      const workspace = dirs.find((d) => d.isDirectory() && !d.name.startsWith('.'))!.name;
      workspaceId = workspace;
      const rulePath = join(fixture.home, 'memory', workspace, 'RULES.md');
      expect(await readFile(rulePath, 'utf8')).toBe('- 提交信息使用简体中文。');
      await writeFile(rulePath, '- 提交信息使用简体中文。\n- 简单文案不跑全量测试。');
      await session.run('继续');
      expect(JSON.stringify(mock.requests.at(-1)!.body)).toContain('<memory-context-update>');
      expect(JSON.stringify(mock.requests.at(-1)!.body)).toContain('简单文案不跑全量测试');
      const other = harness.session();
      sessionIds.push(other.id);
      await other.run('新会话');
      const last = mock.requests.at(-1)!.body as { tools: unknown; system: unknown };
      const original = mock.requests[0]!.body as { tools: unknown; system: unknown };
      expect(last.tools).toEqual(original.tools);
      expect(last.system).toEqual(original.system);
      expect(JSON.stringify(last)).toContain('简单文案不跑全量测试');
      await session.run('/compact');
      await session.run('压缩后继续');
      const compacted = JSON.stringify(mock.requests.at(-1)!.body);
      expect(compacted).toContain('<memory-context>');
      expect(compacted).toContain('were compacted into a summary');
      expect(compacted).toContain('简单文案不跑全量测试');
    } finally {
      await harness.close();
    }
    const resumed = fixture.sdk(mock.baseURL);
    try {
      await (await resumed.resumeSession(sessionIds[0]!)).run('重启后继续');
      const request = JSON.stringify(mock.requests.at(-1)!.body);
      expect(request.match(/<memory-context>/gu)).toHaveLength(1);
      expect(request).toContain('简单文案不跑全量测试');
    } finally {
      await resumed.close();
    }
    const secondDirectory = join(fixture.root, 'another-workspace');
    await mkdir(secondDirectory);
    const isolated = fixture.sdk(mock.baseURL, secondDirectory);
    try {
      await isolated.run('另一个工作区');
      const body = mock.requests.at(-1)!.body as { tools: unknown; system: unknown };
      const original = mock.requests[0]!.body as { tools: unknown; system: unknown };
      expect(body.tools).toEqual(original.tools);
      expect(body.system).toEqual(original.system);
      expect(JSON.stringify(body)).not.toContain('简单文案不跑全量测试');
    } finally {
      await isolated.close();
    }
    for (const id of sessionIds) {
      expect(
        await reconcile(
          join(fixture.home, 'memory'),
          workspaceId,
          join(fixture.home, 'sessions'),
          id,
        ),
      ).toEqual(expect.arrayContaining([expect.stringContaining('OK ')]));
    }
    const auditPath = join(
      fixture.home,
      'memory',
      workspaceId,
      '.decisions-' + sessionIds[0] + '.jsonl',
    );
    const audit = await readFile(auditPath, 'utf8');
    await writeFile(auditPath, audit.replace('missing-snapshot', 'tampered-reason'));
    await expect(
      reconcile(
        join(fixture.home, 'memory'),
        workspaceId,
        join(fixture.home, 'sessions'),
        sessionIds[0]!,
      ),
    ).rejects.toThrow('决策重放不一致');
  } finally {
    await mock.close();
    await fixture.close();
  }
});

it('tarball 可安装到全新 profile，产物没有私有包运行时依赖', async () => {
  const fixture = await createHarnessFixture();
  try {
    const pnpmEntry = process.env.npm_execpath;
    if (!pnpmEntry) throw new Error('请通过 pnpm test:e2e 执行');
    const packArgs = [
      '--dir',
      resolve('packages/plugin'),
      'pack',
      '--pack-destination',
      fixture.root,
    ];
    // pnpm 12 在三大平台都可能提供原生入口；仅脚本入口交给 Node。
    const javascriptEntry = ['.js', '.cjs', '.mjs'].some((suffix) => pnpmEntry.endsWith(suffix));
    await runNode(
      javascriptEntry ? [pnpmEntry, ...packArgs] : packArgs,
      fixture.env,
      resolve('.'),
      javascriptEntry ? process.execPath : pnpmEntry,
    );
    const tarball = (await readdir(fixture.root)).find((name) => name.endsWith('.tgz'))!;
    await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
    await fixture.cli('plugin', '--profile', 'test', 'add', join(fixture.root, tarball));
    expect(await fixture.cli('--profile', 'test', '--dump-config')).toContain(
      '@wahhheee/dsh-stash',
    );
    const mock = await startMockLlmServer({ sequence: ['success'], successText: 'packed ok' });
    const harness = fixture.sdk(mock.baseURL);
    try {
      expect((await harness.run('hello')).finalResponse).toBe('packed ok');
    } finally {
      await harness.close();
      await mock.close();
    }
    const source = await readFile('packages/plugin/lib/index.js', 'utf8');
    expect(source).not.toContain("from '@wahhheee/stash-core'");
  } finally {
    await fixture.close();
  }
});
