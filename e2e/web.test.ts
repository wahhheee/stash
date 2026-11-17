import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import hostManifest from '@deepseek-ai/dsh/package.json' with { type: 'json' };
import { createHarnessFixture } from '../packages/devtools/src/harness.ts';
import { startWebHost } from '../packages/devtools/src/web-host.ts';
import { runNode } from '../packages/devtools/src/harness.ts';
import { readReport } from '../packages/plugin/src/adapters/diagnostics.ts';
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server';
import { randomUUID } from 'node:crypto';
import { DEFAULT_SWITCHES } from '../packages/core/src/index.ts';
import type {
  MemoryPageData,
  PageAction,
  PageMutationResult,
} from '../packages/plugin/src/page-types.ts';
import { reconcile } from '../packages/devtools/src/reconcile.ts';
import { join } from 'node:path';

it('真实 Web 加载客户端模块并通过认证 Gateway 读取状态', async () => {
  const fixture = await createHarnessFixture();
  const mock = await startMockLlmServer({ sequence: ['success'], repeatLast: true });
  try {
    await fixture.cli('--profile', 'web-test', '--from-default-profile', 'web', '--dump-config');
    await fixture.cli('plugin', '--profile', 'web-test', 'add', resolve('packages/plugin'));
    const host = await startWebHost(fixture.home, {
      ...fixture.env,
      DEEPSEEK_BASE_URL: mock.baseURL,
    });
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
        version: '0.5.0',
        hostVersion: hostManifest.version,
        memoryEnabled: true,
      });
      const { sessionId } = await invoke<{ sessionId: string }>('session/create', {
        request: { cwd: fixture.cwd },
      });
      expect(sessionId).toBeTypeOf('string');
      const target = { kind: 'session', id: sessionId };
      const change = (action: PageAction) =>
        invoke<MemoryPageData>('stash/changeMemory', { target, action });
      const initial = await invoke<MemoryPageData>('stash/getMemory', { target });
      expect(initial.files.session).toEqual([]);
      const request = {
        id: randomUUID(),
        action: {
          op: 'note',
          scope: 'workspace',
          path: '/notes/ui/permission.md',
          expected: null,
          value: {
            type: 'fact',
            description:
              'Memory page permissions — Read-only restricts model writes; users can still edit rules and notes.',
            body: 'Details remain in the body.',
            index: true,
            status: null,
            sources: [],
          },
        },
      };
      const created = await invoke<PageMutationResult>('stash/mutateMemory', { target, request });
      expect(created).toMatchObject({
        ok: true,
        scope: 'workspace',
        file: {
          path: request.action.path,
          note: { form: { description: request.action.value.description } },
        },
      });
      expect(await invoke('stash/mutateMemory', { target, request })).toEqual(created);
      expect(
        await invoke('stash/mutateMemory', {
          target,
          request: {
            ...request,
            id: randomUUID(),
            action: {
              ...request.action,
              path: '/notes/ui/invalid.md',
              value: { ...request.action.value, description: '' },
            },
          },
        }),
      ).toMatchObject({ ok: false, code: 'STASH_INVALID_DATA', field: 'description' });
      const edited = await invoke<MemoryPageData>('stash/getMemory', { target });
      expect(
        edited.files.workspace.filter((file) => file.path === request.action.path),
      ).toHaveLength(1);
      await change({
        op: 'save',
        scope: 'workspace',
        path: '/RULES.md',
        content: 'WORKSPACE_SENTINEL',
        expected: null,
      });
      const prompt = async () => {
        const count = mock.requests.length;
        await invoke('session/prompt', {
          request: {
            sessionId,
            requestId: randomUUID(),
            mode: 'queue',
            content: [{ type: 'text', text: '继续' }],
          },
        });
        expect(
          (
            await invoke<{ reason: string }>('session/wait', {
              request: { sessionId, timeoutMs: 10000 },
            })
          ).reason,
        ).toBe('idle');
        expect(mock.requests.length).toBeGreaterThan(count);
        return JSON.stringify(mock.requests.at(-1)!.body);
      };
      await change({
        op: 'switches',
        scope: 'session',
        value: { ...DEFAULT_SWITCHES, inheritWorkspace: false },
      });
      const initialClean = await prompt();
      expect(initialClean).not.toContain('WORKSPACE_SENTINEL');
      await change({
        op: 'save',
        scope: 'session',
        path: '/RULES.md',
        content: 'SESSION_SENTINEL',
        expected: null,
      });
      const clean = await prompt();
      expect(clean).toContain('SESSION_SENTINEL');
      expect(clean).not.toContain('WORKSPACE_SENTINEL');
      expect(clean).toContain('memory_view');
      await change({
        op: 'switches',
        scope: 'session',
        value: { ...DEFAULT_SWITCHES, enabled: false },
      });
      expect(await prompt()).toContain('Memory is off for this session');
      await change({
        op: 'switches',
        scope: 'session',
        value: { ...DEFAULT_SWITCHES, writable: false },
      });
      const readonly = await prompt();
      expect(readonly).toContain('WORKSPACE_SENTINEL');
      expect(readonly).toContain('Memory is read-only');
      await change({ op: 'switches', scope: 'session', value: DEFAULT_SWITCHES });
      await prompt();
      expect(
        await reconcile(
          join(fixture.home, 'memory'),
          initial.workspaceId,
          join(fixture.home, 'sessions'),
          sessionId,
        ),
      ).toEqual(expect.arrayContaining([expect.stringContaining('OK ')]));
      const execute = (line: string) =>
        invoke<{ result: { kind: string; text: string } }>('commands/execute', {
          agentId: sessionId,
          line,
          submittedAttachments: [],
        });
      expect((await execute('/stash status')).result).toMatchObject({
        kind: 'success',
        text: expect.stringContaining('stash 0.5.0'),
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
    await mock.close();
    await fixture.close();
  }
});
