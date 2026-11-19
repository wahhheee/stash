import { z } from 'zod';
import type { PlanStep } from '@wahhheee/stash-core';

export const runId = z.string().regex(/^stash-maint-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u);
export const isMaintenance = (id: string) => runId.safeParse(id).success;
const path = z.string().min(1).max(4096);
const text = { description: z.string().min(1).max(4096), body: z.string().max(1024 * 1024) };

export const stepsSchema: z.ZodType<PlanStep[]> = z
  .array(
    z.discriminatedUnion('op', [
      z.object({ op: z.literal('move'), path, to: path }).strict(),
      z.object({ op: z.literal('archive'), path }).strict(),
      z.object({ op: z.literal('rule'), content: z.string().max(1024 * 1024) }).strict(),
      z.object({ op: z.literal('rewrite'), path, ...text }).strict(),
      z
        .object({ op: z.literal('merge'), path, ...text, from: z.array(path).min(1).max(256) })
        .strict(),
      z
        .object({
          op: z.literal('split'),
          path,
          ...text,
          parts: z
            .array(z.object({ path, ...text }).strict())
            .min(1)
            .max(256),
        })
        .strict(),
    ]),
  )
  .min(1)
  .max(256);

const hash = z.string().regex(/^[a-f0-9]{64}$/u);

const mode = z.enum(['review', 'auto']);
export type MaintenanceMode = z.infer<typeof mode>;

const draftFields = {
  id: runId,
  workspaceId: z.string(),
  base: hash,
  steps: stepsSchema.nullable(),
};

export const stageDraftSchema = z
  .object({
    v: z.literal(3),
    id: runId,
    workspaceId: z.string(),
    mode,
    base: hash,
    working: hash,
    generation: z.uuid(),
    edited: z.boolean(),
    submitted: hash.nullable(),
    baselineAliases: z.array(z.tuple([path, path])),
    redirects: z.array(z.tuple([path, path])),
  })
  .strict();

export type StageDraft = z.infer<typeof stageDraftSchema>;

export const draftSchema = z.union([
  stageDraftSchema,
  z
    .object({ v: z.literal(1), ...draftFields })
    .strict()
    .transform((d) => ({ ...d, v: 2 as const, mode: 'review' as const })),
  z.object({ v: z.literal(2), ...draftFields, mode }).strict(),
]);

export const statsSchema = z
  .object({
    v: z.literal(1),
    notes: z.record(
      z.string(),
      z
        .object({
          reads: z.number().int().nonnegative(),
          lastRead: z.iso.datetime().nullable(),
          created: z.iso.datetime(),
          updated: z.iso.datetime(),
        })
        .strict(),
    ),
  })
  .strict();

export const maintenanceActionSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('inspect') }).strict(),
  z.object({ op: z.literal('start'), requestId: z.uuid(), mode: mode.optional() }).strict(),
  z.object({ op: z.literal('review'), id: runId }).strict(),
  z.object({ op: z.literal('discard'), id: runId }).strict(),
  z.object({ op: z.literal('rollback'), id: runId }).strict(),
  z
    .object({
      op: z.literal('apply'),
      id: runId,
      revision: hash,
      confirmed: z.array(z.number().int().positive()),
    })
    .strict(),
]);

export const reviewSchema = z
  .object({
    id: runId,
    revision: hash,
    changes: z.array(
      z
        .object({
          path,
          before: z.string().nullable(),
          after: z.string().nullable(),
          redirect: path.nullable(),
        })
        .strict(),
    ),
    rules: z.array(
      z
        .object({
          line: z.number().int().positive(),
          before: z.string().nullable(),
          after: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export const maintenanceDataSchema = z
  .object({
    health: z
      .object({
        notes: z.number(),
        unread: z.number(),
        unreadDays: z.number(),
        added: z.number(),
        verifiedDifferent: z.number(),
        verifiedUnknown: z.number(),
        folded: z.boolean(),
        rulesUsed: z.number(),
        rulesLimit: z.number(),
      })
      .strict(),
    runs: z.array(
      z
        .object({
          id: runId,
          mode: mode.optional(),
          archived: z.literal(true).optional(),
          revision: hash.optional(),
          status: z.enum([
            'planning',
            'editing',
            'unchanged',
            'proposed',
            'applied',
            'reverted',
            'stale',
          ]),
        })
        .strict(),
    ),
    review: reviewSchema.nullable(),
    started: runId.nullable(),
  })
  .strict();

export type MaintenanceData = z.infer<typeof maintenanceDataSchema>;
export type MaintenanceAction = z.infer<typeof maintenanceActionSchema>;
