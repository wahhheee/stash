import { z } from 'zod';
import type { PageAction, PageTarget, MemoryPageData } from '../page-types.ts';

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
const file = z.object({ path: z.string(), content: z.string(), revision }).strict();

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
