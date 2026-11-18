import type { JournalChange } from './memory-store.ts';
import { resolveRedirect, notePath, StashError } from '@wahhheee/stash-core';
import type { NoteUsage } from '@wahhheee/stash-core';
import type { statsSchema } from './maintenance-schema.ts';
import { isMaintenance } from './maintenance-schema.ts';
import type { z } from 'zod';

export type Stats = z.infer<typeof statsSchema>;

/** 别名与整理状态由同一份已提交日志派生，无需同步第二个事实源。 */
export function ledger(changes: readonly JournalChange[]) {
  const aliases = new Map<string, string>(),
    groups = new Map<string, 'applied' | 'reverted'>(),
    usage = new Map<string, NoteUsage>();
  const appliedAt = new Map<string, string>();
  for (const c of changes) {
    if (c.group) {
      if (!isMaintenance(c.group)) throw new StashError('STASH_INVALID_DATA', '整理组无效');
      if (c.op === 'maintenance') {
        groups.set(c.group, 'applied');
        appliedAt.set(c.group, c.timestamp);
        if (c.redirect) aliases.set(notePath(c.path), notePath(c.redirect));
      } else if (c.op === 'rollback') {
        groups.set(c.group, 'reverted');
        appliedAt.delete(c.group);
        if (c.redirect) aliases.delete(c.path);
      } else throw new StashError('STASH_INVALID_DATA', '整理日志操作无效');
    }
    if (c.actor === 'ui' && c.callId === 'clear' && c.op === 'delete') {
      const remove = [...aliases.keys()].filter((p) => resolveRedirect(p, aliases) === c.path);
      for (const p of remove) aliases.delete(p);
    }
    if (!c.path.startsWith('/notes/')) continue;
    if (!c.after) usage.delete(c.path);
    else
      usage.set(c.path, {
        created: usage.get(c.path)?.created ?? c.timestamp,
        updated: c.timestamp,
        reads: 0,
        lastRead: null,
      });
  }
  for (const p of aliases.keys()) resolveRedirect(p, aliases);
  return { aliases, groups, usage, lastRun: [...appliedAt.values()].at(-1) ?? null };
}
