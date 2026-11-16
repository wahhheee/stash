import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ResidentRecord } from '@wahhheee/stash-core';
import { z } from 'zod';

export const residentSchema = z
  .object({
    v: z.literal(1),
    workspaceId: z.string(),
    kind: z.enum(['full', 'rules', 'write', 'position']),
    state: z
      .object({
        rules: z.string(),
        index: z.string(),
        folded: z.boolean(),
        session: z
          .object({
            id: z.string(),
            rules: z.string(),
            index: z.string(),
            folded: z.boolean(),
            readOnly: z.boolean().optional(),
            parentRules: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    trusted: z.boolean().optional(),
    scope: z.enum(['workspace', 'session']).optional(),
  })
  .strict();

export const auditSchema = z
  .object({
    v: z.literal(1),
    sessionId: z.string(),
    beforeSeq: z.number().int().nonnegative(),
    journalId: z.string().nullable(),
    config: z
      .object({
        rulesBudgetTokens: z.number().int().positive(),
        indexBudgetTokens: z.number().int().positive(),
        viewBudgetTokens: z.number().int().positive(),
        externalRuleUpdates: z.enum(['next-request', 'next-compaction']),
      })
      .strict(),
    kind: z.enum(['full', 'rules', 'none', 'position']),
    reason: z.string(),
    textHash: z.string(),
    compacted: z.string().nullable(),
    sessionMemory: z.boolean().optional(),
    parent: z
      .object({ id: z.string(), beforeSeq: z.number().int().nonnegative() })
      .strict()
      .optional(),
    readOnly: z.boolean().optional(),
  })
  .strict();

/** 可见状态与谱系识别共用载体解码，失败结果不确认状态。 */
export function eventResident(event: SessionEvent | undefined): ResidentRecord | null {
  if (event?.type === 'user/message' && event.data.source.kind === 'stash-memory')
    return residentSchema.parse(event.data.source.stash);
  if (
    event?.type === 'tool/result' &&
    !event.data.message.isError &&
    event.data.meta &&
    typeof event.data.meta === 'object' &&
    'stash' in event.data.meta
  )
    return residentSchema.parse(event.data.meta.stash);
  return null;
}
