import { readFile, readdir, realpath, writeFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
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
      expect(second).not.toContain('<memory-context-update>');
      expect(second).not.toContain('Replace the previous workspace rules');
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

it('模型请求期间的外部编辑在自身写入后补发，重启重放保持一致', async () => {
  const fixture = await createHarnessFixture();
  let rulePath = '';
  let edited = false;
  const mock = await startMockLlmServer({
    sequence: ['success', 'tool_call_success', 'success'],
    repeatLast: true,
    successText: 'interleaved ok',
    toolName: 'memory_write',
    toolArguments: JSON.stringify({ path: '/RULES.md', op: 'append', content: '\n- 本次模型规则' }),
    onEvent(event) {
      if (event.type === 'request' && event.attempt === 2) {
        writeFileSync(rulePath, '- 已知规则\n- 编辑器新规则');
        edited = true;
      }
    },
  });
  try {
    await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
    await fixture.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
    const harness = fixture.sdk(mock.baseURL);
    let sessionId = '';
    let workspaceId = '';
    try {
      const session = harness.session();
      sessionId = session.id;
      await session.run('建立会话');
      const dirs = await readdir(join(fixture.home, 'memory'), { withFileTypes: true });
      workspaceId = dirs.find((d) => d.isDirectory() && !d.name.startsWith('.'))!.name;
      rulePath = join(fixture.home, 'memory', workspaceId, 'RULES.md');
      await writeFile(rulePath, '- 已知规则');
      await session.run('追加本次模型规则');
      expect(edited).toBe(true);
      const request = JSON.stringify(mock.requests.at(-1)!.body);
      expect(request).toContain('Wrote /RULES.md');
      expect(request).toContain('+ - 编辑器新规则');
      expect(request).toContain('+ - 本次模型规则');
      expect(request).not.toContain('Replace the previous workspace rules');
    } finally {
      await harness.close();
    }
    const resumed = fixture.sdk(mock.baseURL);
    try {
      await (await resumed.resumeSession(sessionId)).run('重启继续');
      expect(
        JSON.stringify(mock.requests.at(-1)!.body).match(/<memory-context-update>/gu),
      ).toHaveLength(2);
    } finally {
      await resumed.close();
    }
    expect(
      await reconcile(
        join(fixture.home, 'memory'),
        workspaceId,
        join(fixture.home, 'sessions'),
        sessionId,
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining('OK ')]));
  } finally {
    await mock.close();
    await fixture.close();
  }
});

it.each(['压缩包', '解压目录'])('全新 profile 离线导入%s后可以写入记忆', async (mode) => {
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
    const tarball = join(
      fixture.root,
      (await readdir(fixture.root)).find((n) => n.endsWith('.tgz'))!,
    );
    let spec = tarball;
    if (mode === '解压目录') {
      await runNode(['-xzf', tarball, '-C', fixture.root], fixture.env, fixture.root, 'tar');
      // DSH 按插件目录解析宿主依赖，传入 Windows 临时目录的短路径会导致激活失败。
      spec = await realpath(join(fixture.root, 'package'));
    }
    // 安装阶段使用空缓存和空存储，防止开发机已下载的依赖掩盖漏打包。
    Object.assign(fixture.env, {
      pnpm_config_offline: 'true',
      pnpm_config_store_dir: join(fixture.root, 'store'),
      pnpm_config_cache_dir: join(fixture.root, 'cache'),
      npm_config_registry: 'http://127.0.0.1:1/',
    });
    await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
    await fixture.cli('plugin', '--profile', 'test', 'add', spec);
    const content = '每次活动通知注明集合时间。';
    const mock = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      toolName: 'memory_write',
      toolArguments: JSON.stringify({ path: '/RULES.md', op: 'create', content }),
    });
    const harness = fixture.sdk(mock.baseURL);
    try {
      await harness.run('记住这条工作区规则。');
      expect(mock.requests[0]?.body, 'DSH 应在首个请求中提供 stash 写入工具').toMatchObject({
        tools: expect.arrayContaining([expect.objectContaining({ name: 'memory_write' })]),
      });
      const memory = join(fixture.home, 'memory');
      const workspaces = (await readdir(memory, { withFileTypes: true })).filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith('.'),
      );
      expect(workspaces).toHaveLength(1);
      expect(await readFile(join(memory, workspaces[0]!.name, 'RULES.md'), 'utf8')).toBe(content);
    } finally {
      await harness.close();
      await mock.close();
    }
  } finally {
    await fixture.close();
  }
});
