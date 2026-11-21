import { NO_CHANGES, PLAN_APPLIED, PLAN_SAVED, STAGED, StashError } from '@wahhheee/stash-core';
import { z } from 'zod';
import type { StageEdit } from './stage-files.ts';
import { stepsSchema } from './maintenance-schema.ts';
import { parseWriteInput } from './write-input.ts';

interface WorkingCopy {
  view(path: string, cursor?: string): Promise<string>;
  edit(edit: StageEdit): Promise<void>;
  diff(cursor?: string): Promise<string>;
}

/** 两种入口共享工具协议；是否需要人工审核由创建副本的一方决定。 */
export async function runStageTool(
  stage: WorkingCopy,
  name: string,
  args: unknown,
  submit: () => Promise<{ applied: boolean; changes: readonly unknown[] }>,
) {
  if (name === 'memory_view') {
    const i = z.object({ path: z.string(), cursor: z.string().optional() }).strict().parse(args);
    return stage.view(i.path, i.cursor);
  }
  if (name === 'memory_write') {
    await stage.edit({ kind: 'write', input: parseWriteInput(args) });
    return STAGED;
  }
  if (name === 'stash_stage') {
    if (
      z
        .object({ op: z.literal('reset') })
        .strict()
        .safeParse(args).success
    )
      await stage.edit({ kind: 'reset' });
    else {
      const [step] = stepsSchema.parse([args]);
      if (!step || !['move', 'merge', 'split'].includes(step.op))
        throw new StashError('STASH_INVALID_DATA', '不支持此结构操作');
      await stage.edit({ kind: 'organize', step });
    }
    return STAGED;
  }
  if (name === 'stash_diff')
    return stage.diff(z.object({ cursor: z.string().optional() }).strict().parse(args).cursor);
  if (name !== 'stash_submit') throw new StashError('STASH_UNSUPPORTED', '未知副本工具');
  z.object({}).strict().parse(args);
  const result = await submit();
  return result.applied ? PLAN_APPLIED : result.changes.length ? PLAN_SAVED : NO_CHANGES;
}
