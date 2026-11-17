import type { NoteForm } from '@wahhheee/stash-core';
import { historyTarget } from '@wahhheee/stash-core/refs';
import type { MemoryPageData, PageMutationResult } from '../page-types.ts';
import type { Translate } from './memory-controls.tsx';

export type MemoryScope = 'workspace' | 'session';
export type MemorySection = 'notes' | 'rules' | 'preferences';

export type MemoryDraft = {
  path: string;
  expected: string | null;
  dirty: boolean;
} & ({ kind: 'note'; value: NoteForm } | { kind: 'rules'; content: string });

export interface MemoryView {
  scope: MemoryScope;
  section: MemorySection;
  path: string | null;
}

export interface MemoryCache {
  views: Map<string, MemoryView>;
  drafts: Map<string, MemoryDraft>;
  navigation: Map<string, number>;
}

export function createMemoryCache(): MemoryCache {
  return { views: new Map(), drafts: new Map(), navigation: new Map() };
}

export function sourceSession(target: string): string | undefined {
  try {
    const history = historyTarget(target, '');
    if (history?.id) return history.id;
  } catch {
    /* 其他形式的来源继续展示原值。 */
  }
  return /^dsh:\/\/session\/([A-Za-z0-9_-]{1,256})\/(?:RULES\.md|notes\/.+\.md)$/u.exec(
    target,
  )?.[1];
}

export function draftKey(data: MemoryPageData, scope: MemoryScope) {
  return scope + ':' + (scope === 'workspace' ? data.workspaceId : data.sessionId);
}

export function nextNotePath(paths: string[], base = '/notes/note.md') {
  if (!paths.includes(base)) return base;
  for (let n = 2; ; n++) {
    const path = base.slice(0, -3) + '-' + n + '.md';
    if (!paths.includes(path)) return path;
  }
}

export function mutationMessage(result: Exclude<PageMutationResult, { ok: true }>, t: Translate) {
  switch (result.code) {
    case 'STASH_STALE_READ':
      return t('conflict');
    case 'STASH_ALREADY_EXISTS':
      return t('exists');
    case 'STASH_BUSY':
      return t('busySession');
    case 'STASH_IO_ERROR':
      return t('connectionError');
    case 'STASH_SECRET':
      return t('secretError');
    case 'STASH_BUDGET_EXCEEDED':
      return t('budgetError')
        .replace('{used}', String(result.used ?? '?'))
        .replace('{limit}', String(result.limit ?? '?'));
    case 'STASH_INVALID_DATA':
      return t('invalidData');
    case 'STASH_NOT_FOUND':
      return t('missingNote');
    case 'STASH_DISABLED':
      return t('globalOff');
    case 'STASH_UNSUPPORTED':
      return t('sessionNotStarted');
    default:
      return t('operationFailed');
  }
}

// 只把完整 Markdown 链接投影成两个输入框；其他原文在用户编辑前保持不变。
export function splitSource(raw: string) {
  const match = /^\[((?:\\.|[^\]])*)\]\((.*)\)$/u.exec(raw);
  return match
    ? { name: match[1]!.replace(/\\([\\[\]])/gu, '$1'), target: match[2]! }
    : { name: '', target: raw };
}

export function joinSource(name: string, target: string) {
  return name ? '[' + name.replace(/[\\[\]]/gu, '\\$&') + '](' + target + ')' : target;
}

export async function copyMemoryText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
