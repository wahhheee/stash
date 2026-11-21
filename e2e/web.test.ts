import { gateway } from './gateway.ts';
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
import { mkdir } from 'node:fs/promises';

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
      const invoke = await gateway(host.url);
      expect(await invoke('stash/getStatus', {})).toMatchObject({
        version: '0.7.0',
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
      const prompt = async (id = sessionId, text = '继续') => {
        const count = mock.requests.length;
        await invoke('session/prompt', {
          request: {
            sessionId: id,
            requestId: randomUUID(),
            mode: 'queue',
            content: [{ type: 'text', text }],
          },
        });
        expect(
          (
            await invoke<{ reason: string }>('session/wait', {
              request: { sessionId: id, timeoutMs: 10000 },
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
        text: expect.stringContaining('stash 0.7.0'),
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

      const status = await invoke('stash/getStatus', {});
      expect(status).toMatchObject({ compactionSupported: true });
      const cwd = join(fixture.root, 'second-workspace');
      await mkdir(cwd);
      const second = await invoke<{ sessionId: string }>('session/create', { request: { cwd } });
      expect(
        (
          await invoke<MemoryPageData>('stash/getMemory', {
            target: { kind: 'session', id: second.sessionId },
          })
        ).workspaceId,
      ).not.toBe(initial.workspaceId);
      const compact = async (id: string, enabled: boolean) => {
        await prompt(id, '作废的草稿。'.repeat(1200));
        const n = mock.requests.length;
        const res = await invoke<{ result: { kind: string; text: string } }>('commands/execute', {
          agentId: id,
          line: '/compact',
          submittedAttachments: [],
        });
        expect(res.result.kind, res.result.text).toBe('success');
        expect(mock.requests.length).toBe(n + (enabled ? 2 : 1));
        const body = mock.requests[n]!.body as {
          tools?: { name?: string; function?: { name: string } }[];
        };
        const names = (body.tools ?? []).map((t) => t.name ?? t.function?.name);
        if (enabled)
          expect(names).toEqual([
            'memory_view',
            'memory_write',
            'stash_stage',
            'stash_diff',
            'stash_submit',
          ]);
        else expect(names).not.toContain('stash_submit');
        expect(JSON.stringify(mock.requests.at(-1)!.body)).toContain('Pending Jobs');
      };
      const settings = await invoke<{
        namespaces: { ns: string; value: unknown; revision: number }[];
      }>('settings/describe', {});
      const global = settings.namespaces.find((x) => x.ns === 'stash');
      expect(global?.value).toMatchObject({ compactionNotes: false });
      const toggle = (value: boolean, expectedRevision: number) =>
        invoke<{ revision: number; value: unknown }>('settings/mutate', {
          ns: 'stash',
          ops: [{ op: 'set', path: ['compactionNotes'], value }],
          expectedRevision,
        });
      await compact(second.sessionId, false);
      const on = await toggle(true, global!.revision);
      expect(on.value).toMatchObject({ compactionNotes: true });
      await compact(sessionId, true);
      await compact(second.sessionId, true);
      const off = await toggle(false, on.revision);
      await compact(sessionId, false);
      await toggle(true, off.revision);
    } finally {
      await host.close();
    }
    const restarted = await startWebHost(fixture.home, {
      ...fixture.env,
      DEEPSEEK_BASE_URL: mock.baseURL,
    });
    try {
      const invoke = await gateway(restarted.url);
      const settings = await invoke<{ namespaces: { ns: string; value: unknown }[] }>(
        'settings/describe',
        {},
      );
      expect(settings.namespaces.find((s) => s.ns === 'stash')?.value).toMatchObject({
        compactionNotes: true,
      });
    } finally {
      await restarted.close();
    }
  } finally {
    await mock.close();
    await fixture.close();
  }
});
