import { stringify } from 'yaml';
import { StashError } from './errors.ts';
import { memoryPath } from './namespace.ts';
import { parseNote, archiveNote } from './notes.ts';
import { expandRules } from './rules.ts';

export interface NoteText {
  description: string;
  body: string;
}

export type PlanStep =
  | ({ op: 'rewrite'; path: string } & NoteText)
  | ({ op: 'merge'; path: string; from: string[] } & NoteText)
  | ({ op: 'split'; path: string; parts: ({ path: string } & NoteText)[] } & NoteText)
  | { op: 'move'; path: string; to: string }
  | { op: 'archive'; path: string }
  | { op: 'rule'; content: string };

export interface PlanChange {
  path: string;
  before: string | null;
  after: string | null;
  redirect: string | null;
}

export interface RuleReview {
  line: number;
  before: string | null;
  after: string | null;
}

export interface PlanPreview {
  changes: PlanChange[];
  rules: RuleReview[];
}

function invalid(): never {
  throw new StashError('STASH_INVALID_DATA', '整理操作的路径、内容或依赖关系无效');
}

export function notePath(path: string) {
  if (!memoryPath(path, true).startsWith('/notes/')) invalid();
  return path;
}

export function resolveRedirect(path: string, redirects: ReadonlyMap<string, string>): string {
  const seen = new Set<string>();
  while (redirects.has(path)) {
    if (seen.has(path)) invalid();
    seen.add(path);
    path = notePath(redirects.get(path)!);
  }
  return path;
}

/** 所有操作针对同一份输入；重复目标、别名复用和目录/文件冲突一律拒绝。 */
export function previewPlan(
  files: ReadonlyMap<string, string>,
  steps: readonly PlanStep[],
  aliases: ReadonlyMap<string, string>,
): PlanPreview {
  const next = new Map(files),
    changes: PlanChange[] = [],
    touched = new Set<string>();
  const note = (path: string) => parseNote(files.get(notePath(path)) ?? invalid());
  const put = (path: string, after: string | null, redirect: string | null = null) => {
    const key = path.toLowerCase();
    if (touched.has(key) || [...aliases.keys()].some((p) => p.toLowerCase() === key)) invalid();
    touched.add(key);
    const before = files.get(path) ?? null;
    if (after === null) next.delete(path);
    else {
      if (path !== '/RULES.md') parseNote(after);
      next.set(path, after);
    }
    if (before !== after) changes.push({ path, before, after, redirect });
  };
  const render = (fields: Record<string, unknown>, text: NoteText) =>
    '---\n' + stringify({ ...fields, description: text.description }) + '---\n' + text.body;
  for (const step of steps) {
    if (step.op === 'rule') {
      put('/RULES.md', step.content);
      continue;
    }
    const source = note(step.path);
    if (step.op === 'move') {
      if (files.has(notePath(step.to))) invalid();
      put(step.to, files.get(step.path)!);
      put(step.path, null, step.to);
      continue;
    }
    if (step.op === 'archive') {
      put(step.path, archiveNote(files.get(step.path)!));
      continue;
    }
    if (step.op === 'merge') {
      const union = new Map<string, unknown>();
      for (const path of [step.path, ...step.from]) {
        const { sources } = note(path).fields;
        for (const s of sources === undefined ? [] : Array.isArray(sources) ? sources : [sources])
          union.set(JSON.stringify(s), s);
      }
      if (union.size) source.fields.sources = [...union.values()];
      for (const path of step.from) put(path, null, step.path);
    }
    put(step.path, render(source.fields, step));
    if (step.op === 'split')
      for (const part of step.parts) {
        if (files.has(notePath(part.path))) invalid();
        put(part.path, render(source.fields, part));
      }
  }
  const names = [
    ...next.keys(),
    ...aliases.keys(),
    ...changes.flatMap((c) => (c.redirect ? [c.path] : [])),
  ].map((p) => p.toLowerCase());
  const unique = new Set(names);
  if (
    unique.size !== names.length ||
    names.some((p) => p.split('/').some((_, i, parts) => unique.has(parts.slice(0, i).join('/'))))
  )
    invalid();
  const beforeRules = expandRules(files),
    afterRules = expandRules(next);
  const rules: RuleReview[] = [];
  // 比较实际生效的规则，包括 @ 引用的正文；行号也属于确认对象。
  if (beforeRules !== afterRules) {
    const a = beforeRules.split('\n'),
      b = afterRules.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i]) rules.push({ line: i + 1, before: a[i] ?? null, after: b[i] ?? null });
  }
  if (!changes.length) invalid();
  return { changes, rules };
}

export interface NoteUsage {
  reads: number;
  lastRead: string | null;
  created: string;
  updated: string;
}

export interface Health {
  notes: number;
  unread: number;
  unreadDays: number;
  added: number;
  verifiedDifferent: number;
  verifiedUnknown: number;
  folded: boolean;
  rulesUsed: number;
  rulesLimit: number;
}

export function healthCounts(
  files: ReadonlyMap<string, string>,
  usage: ReadonlyMap<string, NoteUsage>,
  now: number,
  days: number,
  lastRun: string | null,
  head: string | null,
) {
  let unread = 0,
    added = 0,
    verifiedDifferent = 0,
    verifiedUnknown = 0;
  for (const [path, stat] of usage) {
    if (now - Date.parse(stat.lastRead ?? stat.created) >= days * 86400000) unread++;
    if (!lastRun || stat.created > lastRun) added++;
    const verified = parseNote(files.get(path)!).fields.verified;
    if (verified !== undefined) {
      const commit =
        typeof verified === 'string'
          ? /(?:^|@\s*)([0-9a-f]{7,40})\s*$/iu.exec(verified)?.[1]
          : null;
      if (!commit || !head) verifiedUnknown++;
      else if (!head.startsWith(commit.toLowerCase())) verifiedDifferent++;
    }
  }
  return { notes: usage.size, unread, added, verifiedDifferent, verifiedUnknown };
}
