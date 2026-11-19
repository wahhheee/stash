import {
  archiveNote,
  compareRules,
  memoryPath,
  notePath,
  parseNote,
  previewPlan,
  resolveRedirect,
  StashError,
} from '@wahhheee/stash-core';
import type { PlanStep, WriteInput, PlanChange } from '@wahhheee/stash-core';
import { containsSecret } from './redaction.ts';

export type StageEdit =
  { kind: 'write'; input: WriteInput } | { kind: 'organize'; step: PlanStep } | { kind: 'reset' };

export function fileChanges(
  base: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  redirects: ReadonlyMap<string, string> = new Map(),
): PlanChange[] {
  return [...new Set([...base.keys(), ...next.keys()])].sort().flatMap((path) => {
    const before = base.get(path) ?? null,
      after = next.get(path) ?? null;
    return before === after ? [] : [{ path, before, after, redirect: redirects.get(path) ?? null }];
  });
}

export function validateStagePaths(
  files: ReadonlyMap<string, string>,
  aliases: ReadonlyMap<string, string>,
) {
  const names = [...files.keys(), ...aliases.keys()].map((p) => memoryPath(p, true).toLowerCase());
  const unique = new Set(names);
  if (
    unique.size !== names.length ||
    names.some((p) => p.split('/').some((_, i, parts) => unique.has(parts.slice(0, i).join('/'))))
  )
    throw new StashError('STASH_INVALID_DATA', '副本路径冲突', { kind: 'path-case' });
  for (const [from, to] of aliases) {
    notePath(from);
    if (!files.has(resolveRedirect(notePath(to), aliases)))
      throw new StashError('STASH_INVALID_DATA', '重定向目标缺失', { kind: 'maintenance-alias' });
  }
}

export function editStage(
  files: Map<string, string>,
  aliases: Map<string, string>,
  edit: Exclude<StageEdit, { kind: 'reset' }>,
) {
  if (containsSecret(JSON.stringify(edit)))
    throw new StashError('STASH_SECRET', '副本不得保存凭据');
  if (edit.kind === 'organize') {
    for (const c of previewPlan(files, [edit.step], aliases, true).changes) {
      if (c.after === null) files.delete(c.path);
      else files.set(c.path, c.after);
      if (c.redirect) aliases.set(c.path, c.redirect);
    }
  } else {
    const i = edit.input,
      path = memoryPath(i.path, true),
      old = files.get(path);
    if (aliases.has(path))
      throw new StashError('STASH_READ_ONLY', '不能写入旧路径', { kind: 'maintenance-alias' });
    if (i.op === 'create' && old !== undefined)
      throw new StashError('STASH_ALREADY_EXISTS', '文件已经存在');
    if (i.op !== 'create' && old === undefined)
      throw new StashError('STASH_NOT_FOUND', '文件不存在');
    if (path === '/RULES.md' && (i.op === 'delete' || i.op === 'archive'))
      throw new StashError('STASH_UNSUPPORTED', '不能删除规则', {
        kind: 'rules-operation',
        operation: i.op,
      });
    let content: string | null;
    switch (i.op) {
      case 'replace':
      case 'create':
        content = i.content;
        break;
      case 'archive':
        content = archiveNote(old!);
        break;
      case 'append':
        content = old! + i.content;
        break;
      case 'delete':
        content = null;
        break;
      case 'edit': {
        const count = old!.split(i.old).length - 1;
        if (!i.old || count !== 1)
          throw new StashError('STASH_INVALID_DATA', '定位文本必须唯一', {
            kind: 'edit-match',
            count,
          });
        content = old!.replace(i.old, () => i.new);
        break;
      }
    }
    if (content === null) files.delete(path);
    else {
      if (containsSecret(content)) throw new StashError('STASH_SECRET', '禁止保存凭据');
      if (path !== '/RULES.md') parseNote(content);
      files.set(path, content);
    }
  }
  validateStagePaths(files, aliases);
}

export function stagePreview(
  base: Map<string, string>,
  files: Map<string, string>,
  original: Map<string, string>,
  aliases: Map<string, string>,
) {
  validateStagePaths(files, aliases);
  // 中间创建又移走的路径从未对正式会话可见；只为基线中的旧笔记建立跳转。
  const redirects = new Map(
    [...aliases]
      .filter(([p]) => base.has(p) && !original.has(p))
      .map(([p, to]) => [p, resolveRedirect(to, aliases)]),
  );
  return { changes: fileChanges(base, files, redirects), rules: compareRules(base, files) };
}
