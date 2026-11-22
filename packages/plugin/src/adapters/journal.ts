import { z } from 'zod';
import { memoryPath, notePath, StashError, type MemoryFile } from '@wahhheee/stash-core';
import { runId } from './maintenance-schema.ts';
import { containsSecret } from './redaction.ts';
import { digest } from './revision.ts';

const fileSchema = z.object({ content: z.string(), revision: z.string() }).strict();

export const changeSchema = z
  .object({
    v: z.literal(1),
    id: z.string(),
    workspaceId: z.string(),
    path: z.string(),
    before: fileSchema.nullable(),
    after: fileSchema.nullable(),
    timestamp: z.iso.datetime(),
    actor: z.string(),
    callId: z.string(),
    op: z.string(),
    group: runId.optional(),
    redirect: z.string().optional(),
  })
  .strict();

export type JournalChange = z.infer<typeof changeSchema>;

export interface JournalCache {
  mtimeMs: number | null;
  size: number;
  changes: JournalChange[];
  states: Map<string, MemoryFile | null>;
  ids: Set<string>;
  terminated: boolean;
  aliases?: Map<string, string>;
}

export function parseJournal(id: string, text: string): JournalCache {
  const changes = text
    .split('\n')
    .filter(Boolean)
    .map((line) => changeSchema.parse(JSON.parse(line)));
  const journal: JournalCache = {
    mtimeMs: null,
    size: 0,
    changes: [],
    states: new Map(),
    ids: new Set(),
    terminated: !text || text.endsWith('\n'),
  };
  for (const change of changes) acceptChange(id, journal, change);
  return journal;
}

export function validateChange(id: string, change: JournalChange): void {
  memoryPath(change.path, true);
  if (
    Boolean(change.group) !== ['maintenance', 'rollback'].includes(change.op) ||
    (change.group && (change.group !== change.actor || change.group !== change.callId)) ||
    (change.redirect &&
      (!change.group ||
        (change.op === 'maintenance'
          ? change.after !== null || change.before === null
          : change.before !== null || change.after === null)))
  )
    throw new StashError('STASH_INVALID_DATA', '整理日志标识或跳转记录无效');
  if (change.redirect) {
    notePath(change.path);
    notePath(change.redirect);
  }
  if (change.workspaceId !== id) throw new StashError('STASH_INVALID_DATA', '修改日志工作区不符');
  for (const file of [change.before, change.after]) {
    if (file && digest(file.content) !== file.revision)
      throw new StashError('STASH_INVALID_DATA', '修改日志哈希损坏');
    if (file && containsSecret(file.content))
      throw new StashError('STASH_SECRET', '修改记录包含凭据');
  }
}

export function acceptChange(id: string, journal: JournalCache, change: JournalChange): void {
  validateChange(id, change);
  if (
    journal.ids.has(change.id) ||
    (journal.states.get(change.path)?.revision ?? null) !== (change.before?.revision ?? null)
  )
    throw new StashError('STASH_INVALID_DATA', '修改日志链损坏');
  if (change.group || change.callId === 'clear') delete journal.aliases;
  journal.changes.push(change);
  journal.ids.add(change.id);
  journal.states.set(change.path, change.after);
}

export function appendText(journal: JournalCache, change: JournalChange): string {
  const text = (journal.terminated ? '' : '\n') + JSON.stringify(change) + '\n';
  if (journal.size + Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new StashError('STASH_INVALID_DATA', '修改日志超过 32 MiB', { kind: 'storage-size' });
  return text;
}
