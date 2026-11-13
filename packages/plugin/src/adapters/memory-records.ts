import { z } from 'zod';

export const residentSchema = z
  .object({
    v: z.literal(1),
    workspaceId: z.string(),
    kind: z.enum(['full', 'rules', 'write']),
    state: z.object({ rules: z.string(), index: z.string(), folded: z.boolean() }).strict(),
    trusted: z.boolean().optional(),
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
    kind: z.enum(['full', 'rules', 'none']),
    reason: z.string(),
    textHash: z.string(),
    compacted: z.string().nullable(),
  })
  .strict();
