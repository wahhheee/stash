import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {
  ToolRegistrationOptions,
  ToolRunContext,
  ToolOutputDefinition,
} from '@deepseek-ai/dsh-tools';
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm';
import { z } from 'zod';
import {
  PLAN_ONLY,
  DIFF_TOOL,
  STAGE_TOOL,
  SUBMIT_TOOL,
  STAGE_VIEW_TOOL,
  STAGE_WRITE_TOOL,
  VIEW_TOOL,
  WRITE_TOOL,
  StashError,
  toolError,
  foldResident,
  sessionMemoryTarget,
  sessionWriteResult,
  historyTarget,
  type ResidentRecord,
} from '@wahhheee/stash-core';
import { StageSession } from '../host/stage-session.ts';
import { HistoryBrowser } from '../host/history.ts';
import { validatePlan } from '../host/maintenance.ts';
import { runStageTool } from './stage-tools.ts';
import { parseWriteInput } from './write-input.ts';
import { visibleRecords } from './resident-dsh.ts';
import { commitMessage } from './session-memory.ts';
import type { MemoryAdapter } from './memory-dsh.ts';

const viewSchema = z
  .object({
    path: z.string(),
    cursor: z.string().optional(),
    query: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    detail: z.enum(['brief', 'full']).optional(),
    all: z.boolean().optional(),
  })
  .strict();

async function toolBoundary<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const code =
      error instanceof StashError
        ? error.code
        : error instanceof z.ZodError
          ? 'STASH_INVALID_DATA'
          : 'STASH_IO_ERROR';
    throw new HarnessError(
      toolError(code, error instanceof StashError ? error.detail : undefined),
      code,
    );
  }
}

const textOutput: ToolOutputDefinition = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
};

export function registerStageTools(
  scope: Context,
  agent: Agent,
  adapter: MemoryAdapter,
  activation: ToolRegistrationOptions,
) {
  scope.tools.restrict({ allow: [] });
  const tools = [STAGE_VIEW_TOOL, STAGE_WRITE_TOOL, STAGE_TOOL, DIFF_TOOL, SUBMIT_TOOL];
  scope.tools.guard((exec) =>
    exec.name === 'run_code' || tools.some((t) => t.name === exec.name) ? undefined : PLAN_ONLY,
  );
  let stage: StageSession | undefined;
  for (const tool of tools)
    scope.tools.register(
      {
        ...tool,
        output: textOutput,
        execute: async (args, exec) =>
          toolBoundary(async () => {
            exec.signal.throwIfAborted();
            const policy = await adapter.policy(agent);
            if (!policy.enabled || !policy.inheritWorkspace)
              throw new StashError('STASH_DISABLED', '工作区记忆未启用');
            const memory = await adapter.memory(agent);
            stage ??= new StageSession(
              adapter.store,
              memory.workspaceId,
              agent.id,
              adapter.meter,
              adapter.config.viewBudgetTokens,
              () => adapter.requireActivePlan(agent.id),
            );
            const copy = stage;
            return runStageTool(copy, tool.name, args, () =>
              copy.submit((files) => validatePlan(files, adapter.meter, adapter.config)),
            );
          }),
      },
      activation,
    );
}

export function registerMemoryTools(
  scope: Context,
  agent: Agent,
  adapter: MemoryAdapter,
  activation: ToolRegistrationOptions,
) {
  let browser: HistoryBrowser | undefined;
  let previousPrivacy: string | undefined;
  async function view(args: unknown, exec: ToolRunContext) {
    if (!(await adapter.policy(agent)).enabled)
      throw new StashError('STASH_DISABLED', '记忆已关闭');
    const input = viewSchema.parse(args);

    const memory = await adapter.memory(agent);
    const target = sessionMemoryTarget(input.path, agent.id);
    if ((target && !target.writable) || (!target && historyTarget(input.path, agent.id))) {
      const domain = await adapter.switches.ready;
      const privacy = JSON.stringify([...domain.table('sessions').entries()]);

      if (previousPrivacy !== privacy) {
        browser?.clearPages();
        previousPrivacy = privacy;
      }
      if (!browser) {
        browser = new HistoryBrowser(
          await adapter.history,
          memory.workspaceId,
          agent.id,
          adapter.meter,
          adapter.config.viewBudgetTokens,
          {
            discoverable: (id, current) =>
              id === current || (domain.table('sessions').get(id)?.discoverable ?? true),
          },
        );
      }
      return browser.view(input);
    }
    if (
      input.query !== undefined ||
      input.since !== undefined ||
      input.until !== undefined ||
      input.detail !== undefined ||
      input.all !== undefined
    )
      throw new StashError('STASH_UNSUPPORTED', '这些选项只用于历史路径', {
        kind: 'history-options',
      });
    if (!target) return memory.view(input.path, input.cursor, input.path);
    const session = await adapter.sessionMemory(agent);
    session.store.begin(exec.rootCallId);
    return session.memory.view(target.path, input.cursor, input.path);
  }
  async function write(args: unknown, exec: ToolRunContext) {
    exec.signal.throwIfAborted();
    const policy = await adapter.policy(agent);
    if (!policy.enabled) throw new StashError('STASH_DISABLED', '记忆已关闭');
    if (!policy.writable)
      throw new StashError('STASH_READ_ONLY', '记忆只读', {
        kind: 'read-only',
        reason: 'policy',
      });
    if (agent.session.header.origin === 'subagent' && !adapter.config.subagentWrite)
      throw new StashError('STASH_READ_ONLY', '子代理只读', {
        kind: 'read-only',
        reason: 'subagent',
      });
    const input = parseWriteInput(args);
    const memory = await adapter.memory(agent);
    const believed = foldResident(visibleRecords(agent), memory.workspaceId);
    const target = sessionMemoryTarget(input.path, agent.id);
    if (target && !target.writable)
      throw new StashError('STASH_READ_ONLY', '其他会话只读', {
        kind: 'read-only',
        reason: 'sibling',
      });
    if (!target && historyTarget(input.path, agent.id))
      throw new StashError('STASH_READ_ONLY', '历史记录只读', {
        kind: 'read-only',
        reason: 'history',
      });
    const session = await adapter.sessionMemory(agent);
    session.store.begin(exec.rootCallId);
    const result = target
      ? await session.memory.write(
          { ...input, path: target.path },
          exec.callId,
          believed?.session?.rules ?? null,
        )
      : await memory.write(input, exec.callId, believed?.rules ?? null);
    const text = target ? sessionWriteResult(result.text, target.path, input.op) : result.text;
    const state = target
      ? await adapter.actual(agent, await memory.actual())
      : await adapter.actual(agent, result.state);
    const stash: ResidentRecord = {
      v: 1,
      workspaceId: memory.workspaceId,
      kind: 'write',
      scope: target ? 'session' : 'workspace',
      state,
      // 嵌套调用的参数未必进入模型可见结果，按保守补发处理。
      trusted: result.trusted && !exec.parent,
    };
    const commit = target ? session.store.lastCommit() : undefined;
    if (exec.parent && commit) exec.deferContext(commitMessage(commit, text));
    if (exec.parent && !commit)
      exec.deferContext(
        createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'stash-memory', form: 'instructions', stash },
        }),
      );
    return { text, stash, ...(commit ? { stashCommit: commit } : {}) };
  }
  scope.tools.register(
    {
      ...VIEW_TOOL,
      output: textOutput,
      execute: (args, exec) => toolBoundary(() => view(args, exec)),
    },
    activation,
  );
  scope.tools.register(
    {
      ...WRITE_TOOL,
      output: {
        schema: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            stash: { type: 'object', additionalProperties: true },
            stashCommit: { type: 'object', additionalProperties: true },
          },
          required: ['text', 'stash'],
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: z.object({ text: z.string() }).parse(value).text },
        ],
        presentationMeta: (_args, value) => value,
      },
      execute: (args, exec) => toolBoundary(() => write(args, exec)),
    },
    activation,
  );
}
