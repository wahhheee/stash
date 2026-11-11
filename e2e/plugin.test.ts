import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture, runNode } from '../packages/devtools/src/harness.ts';

it('真实 DSH 本地链接、SDK 对话与无插件模型请求一致', async () => {
  const fixture = await createHarnessFixture();
  const mock = await startMockLlmServer({
    sequence: ['success'],
    repeatLast: true,
    successText: 'stash e2e ok',
  });
  try {
    await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
    const before = fixture.sdk(mock.baseURL);
    try {
      expect((await before.run('只回答 OK')).finalResponse).toBe('stash e2e ok');
    } finally {
      await before.close();
    }
    const baseline = JSON.stringify(mock.requests[0]!.body);
    await fixture.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
    expect(await fixture.cli('--profile', 'test', '--dump-config')).toContain(
      '@wahhheee/dsh-stash',
    );
    const after = fixture.sdk(mock.baseURL);
    try {
      expect((await after.run('只回答 OK')).finalResponse).toBe('stash e2e ok');
      const actual = JSON.stringify(mock.requests.at(-1)!.body);
      const offset = [...baseline].findIndex((char, i) => char !== actual[i]);
      expect(
        actual === baseline,
        '首个差异: ' +
          baseline.slice(offset, offset + 180) +
          ' -> ' +
          actual.slice(offset, offset + 180),
      ).toBe(true);
      expect(mock.requests).toHaveLength(2);
    } finally {
      await after.close();
    }
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
    await runNode(
      pnpmEntry.endsWith('.exe') ? packArgs : [pnpmEntry, ...packArgs],
      fixture.env,
      resolve('.'),
      pnpmEntry.endsWith('.exe') ? pnpmEntry : process.execPath,
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
