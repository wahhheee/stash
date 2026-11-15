import { resolve, join } from 'node:path';
import { expect, it } from 'vitest';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';
import { viewHistory } from '../packages/devtools/src/history.ts';

it('复制链接粘贴后通过真实 SDK 工具读取已压缩冷会话的原始轮次', async () => {
  const fixture = await createHarnessFixture();
  const sourceMock = await startMockLlmServer({
    sequence: ['success'],
    repeatLast: true,
    successText: '昨晚的架构结论：保留字面扫描',
  });
  let reference = '';
  try {
    await fixture.cli('--profile', 'test', '--from-default-profile', 'sdk', '--dump-config');
    await fixture.cli('plugin', '--profile', 'test', 'add', resolve('packages/plugin'));
    const host = fixture.sdk(sourceMock.baseURL);
    try {
      const source = host.session();
      await source.run('讨论架构取舍');
      await source.run('/compact');
      reference = 'dsh://session/' + source.id;
    } finally {
      await host.close();
    }
    const id = reference.split('/').at(-1)!;
    const outline = await viewHistory(join(fixture.home, 'sessions'), fixture.cwd, id, {
      path: './log/turns',
    });
    const range = /dsh:\/\/session\/[^/\s]+\/\d+\.\.\d+/u.exec(outline)?.[0];
    expect(range).toBeDefined();
    const mock = await startMockLlmServer({
      sequence: ['tool_call_success', 'success'],
      repeatLast: true,
      successText: '已找回讨论',
      toolName: 'memory_view',
      toolArguments: JSON.stringify({ path: range }),
    });
    const reader = fixture.sdk(mock.baseURL);
    try {
      await reader.run('[「昨晚讨论」第 1 轮](' + range + ') 请读取这段记录。');
      const request = JSON.stringify(mock.requests.at(-1)!.body);
      expect(request).toContain('昨晚的架构结论');
      expect(request).toContain('Reference data only');
      expect(request).not.toContain('STASH_HISTORY_UNREADABLE');
    } finally {
      await reader.close();
      await mock.close();
    }
  } finally {
    await sourceMock.close();
    await fixture.close();
  }
});
