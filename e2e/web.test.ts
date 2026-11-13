import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';
import { startWebHost } from '../packages/devtools/src/web-host.ts';
import { runNode } from '../packages/devtools/src/harness.ts';
import { readReport } from '../packages/plugin/src/adapters/diagnostics.ts';

it('真实 Web 加载客户端模块并通过认证 Gateway 读取状态', async () => {
  const fixture = await createHarnessFixture();
  try {
    await fixture.cli('--profile', 'web-test', '--from-default-profile', 'web', '--dump-config');
    await fixture.cli('plugin', '--profile', 'web-test', 'add', resolve('packages/plugin'));
    const host = await startWebHost(fixture.home, fixture.env);
    try {
      const exchange = await fetch(host.url, { redirect: 'manual' });
      const cookie = exchange.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      expect(cookie).not.toBe('');
      const origin = new URL(host.url).origin;
      const page = await fetch(origin, { headers: { cookie } });
      const html = await page.text();
      expect(html).toContain('@wahhheee/dsh-stash');
      const invoke = async <T>(method: string, args: Record<string, unknown>): Promise<T> => {
        const response = await fetch(origin + '/api/' + method, {
          method: 'POST',
          headers: { cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'client-request',
            rpcId: method,
            method,
            payload: { args },
          }),
        });
        expect(response.status).toBe(200);
        const envelope = (await response.json()) as {
          type: string;
          result: { ok: boolean; value: T };
        };
        expect(envelope.type).toBe('server-response');
        expect(envelope.result.ok, JSON.stringify(envelope)).toBe(true);
        return envelope.result.value;
      };
      expect(await invoke('stash/getStatus', {})).toMatchObject({
        version: '0.2.0',
        memoryEnabled: true,
      });
      const { sessionId } = await invoke<{ sessionId: string }>('session/create', {
        request: { cwd: fixture.cwd },
      });
      expect(sessionId).toBeTypeOf('string');
      const execute = (line: string) =>
        invoke<{ result: { kind: string; text: string } }>('commands/execute', {
          agentId: sessionId,
          line,
          submittedAttachments: [],
        });
      expect((await execute('/stash status')).result).toMatchObject({
        kind: 'success',
        text: expect.stringContaining('stash 0.2.0'),
      });
      const bundle = await execute('/stash doctor --bundle');
      expect(bundle.result.kind).toBe('success');
      expect(bundle.result.text).toContain('bundle:');
      const reportPath = bundle.result.text.split('bundle: ')[1]!;
      expect((await readReport(reportPath)).checks.every((check) => check.ok)).toBe(true);
      const verification = await runNode(
        ['--import', 'tsx', resolve('packages/devtools/src/cli.ts'), 'verify', reportPath],
        fixture.env,
      );
      expect(verification).toContain('OK dsh');
    } finally {
      await host.close();
    }
  } finally {
    await fixture.close();
  }
});
