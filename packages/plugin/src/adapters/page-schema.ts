import { z } from 'zod';
import type {
  PageAction,
  PageTarget,
  MemoryPageData,
  PageMutation,
  PageMutationResult,
} from '../page-types.ts';

export const switchSchema = z
  .object({
    v: z.literal(1),
    enabled: z.boolean().nullable(),
    writable: z.boolean().nullable(),
    discoverable: z.boolean(),
    inheritWorkspace: z.boolean(),
  })
  .strict();

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/u);
const revision = z.string().regex(/^[a-f0-9]{64}$/u);
const scope = z.enum(['workspace', 'session']);

export const noteFormSchema = z
  .object({
    type: z.string(),
    description: z.string(),
    body: z.string().max(32 * 1024 * 1024),
    index: z.boolean(),
    status: z.string().nullable(),
    sources: z.array(z.string()).optional(),
  })
  .strict();

const note = z
  .object({
    form: noteFormSchema,
    preservedSources: z.string().nullable(),
    additionalFields: z.array(z.string()),
  })
  .strict();

const file = z
  .object({ path: z.string(), content: z.string(), revision, note: note.nullable().optional() })
  .strict();

export const targetSchema: z.ZodType<PageTarget> = z.object({ kind: scope, id }).strict();

export const actionSchema: z.ZodType<PageAction> = z.discriminatedUnion('op', [
  z.object({ op: z.literal('switches'), scope, value: switchSchema }).strict(),
  z
    .object({
      op: z.literal('save'),
      scope,
      path: z.string().max(4096),
      content: z
        .string()
        .max(32 * 1024 * 1024)
        .nullable(),
      expected: revision.nullable(),
    })
    .strict(),
  z
    .object({
      op: z.literal('promote'),
      path: z.string().max(4096),
      destination: z.string().max(4096),
      expected: revision,
    })
    .strict(),
  z
    .object({ op: z.literal('clear'), scope, expected: revision, confirm: z.literal(true) })
    .strict(),
]);

export const pageSchema: z.ZodType<MemoryPageData> = z
  .object({
    sessionEditable: z.boolean(),
    workspaceId: id,
    title: z.string(),
    sessionId: id.nullable(),
    sessionTitle: z.string().optional(),
    globalEnabled: z.boolean(),
    workspace: switchSchema,
    session: switchSchema,
    effective: z
      .object({
        enabled: z.boolean(),
        writable: z.boolean(),
        discoverable: z.boolean(),
        inheritWorkspace: z.boolean(),
        source: z.enum(['global', 'workspace', 'session']),
      })
      .strict(),
    files: z.object({ workspace: z.array(file), session: z.array(file) }).strict(),
    revisions: z.object({ workspace: revision, session: revision }).strict(),
  })
  .strict();

export const mutationSchema: z.ZodType<PageMutation> = z
  .object({
    id: z.string().uuid(),
    action: z.union([
      actionSchema,
      z
        .object({
          op: z.literal('note'),
          scope,
          path: z.string().max(4096),
          expected: revision.nullable(),
          value: noteFormSchema,
        })
        .strict(),
    ]),
  })
  .strict();

export const mutationResultSchema: z.ZodType<PageMutationResult> = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), scope, file: file.nullable(), cleared: z.boolean() }).strict(),
  z
    .object({
      ok: z.literal(false),
      code: z.string(),
      field: z.string().optional(),
      used: z.number().optional(),
      limit: z.number().optional(),
    })
    .strict(),
]);
