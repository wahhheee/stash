import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';

for (const mode of ['standard', 'ptc'])
  it(mode + ' 开始即全局关闭的 SDK 请求与未安装插件逐字节相同', async () => {
    const fixture = await createHarnessFixture();
    const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true });
    try {
      await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
      const modePatch = join(fixture.root, 'mode.patch.yml');
      await writeFile(
        modePatch,
        mode === 'ptc'
          ? '- id: tool-executor-native\n  disabled: true\n- id: tool-executor-ptc\n  disabled: false\n'
          : '[]\n',
      );
      const baseline = fixture.sdk(mock.baseURL, fixture.cwd, [modePatch]);
      try {
        await baseline.run('一致性测试');
      } finally {
        await baseline.close();
      }
      const original = JSON.stringify(mock.requests.at(-1)!.body);
      await fixture.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
      const disabled = join(fixture.root, 'disabled.patch.yml');
      await writeFile(disabled, '- id: stash\n  config:\n    enabled: false\n');
      const host = fixture.sdk(mock.baseURL, fixture.cwd, [modePatch, disabled]);
      try {
        await host.run('一致性测试');
      } finally {
        await host.close();
      }
      expect(JSON.stringify(mock.requests.at(-1)!.body)).toBe(original);
      expect(original).not.toContain('memory_view');
    } finally {
      await mock.close();
      await fixture.close();
    }
  });
