import { StashError } from './errors.ts';
import type { EventWindow } from './ports/index.ts';

export interface HistoryTarget {
  id?: string;
  explicit: boolean;
  view: 'sessions' | 'turns' | 'summaries' | 'events';
  window?: EventWindow;
}

export function sessionId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,256}$/u.test(value))
    throw new StashError('STASH_INVALID_DATA', '无效会话 ID', { kind: 'session-id' });
  return value;
}

export function sessionRef(id: string, window?: EventWindow): string {
  return (
    'dsh://session/' +
    sessionId(id) +
    (window ? '/' + window.from + (window.to === window.from ? '' : '..' + window.to) : '')
  );
}

export function historyTarget(path: string, current: string): HistoryTarget | null {
  if (path === '/sessions' || path === '/sessions/') return { explicit: false, view: 'sessions' };
  if (path.startsWith('dsh-session:')) {
    try {
      const encoded = path.slice(12);
      if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) throw new Error();
      const id: unknown = JSON.parse(atob(encoded.replace(/-/gu, '+').replace(/_/gu, '/')));
      if (typeof id !== 'string') throw new Error();
      return { id: sessionId(id), explicit: true, view: 'turns' };
    } catch {
      throw new StashError('STASH_INVALID_DATA', '无效会话引用', { kind: 'session-reference' });
    }
  }
  let id: string,
    suffix: string,
    explicit = false;
  if (path.startsWith('dsh://')) {
    const match = /^dsh:\/\/session\/([^/]+)(?:\/(.*))?$/u.exec(path);
    if (!match)
      throw new StashError('STASH_INVALID_DATA', '无效会话引用', { kind: 'session-reference' });
    id = sessionId(match[1]!);
    suffix = match[2] ?? 'turns';
    explicit = true;
  } else if (path === './log' || path.startsWith('./log/')) {
    id = current;
    suffix = path.slice(6) || 'turns';
  } else if (path.startsWith('/sessions/')) {
    const match = /^\/sessions\/([^/]+)(?:\/log(?:\/(.*))?)?$/u.exec(path);
    if (!match)
      throw new StashError('STASH_INVALID_DATA', '无效历史路径', { kind: 'history-path' });
    id = sessionId(match[1]!);
    suffix = match[2] || 'turns';
  } else return null;
  if (suffix === 'turns' || suffix === 'summaries') return { id, explicit, view: suffix };
  const match = /^(0|[1-9]\d*)(?:\.\.(0|[1-9]\d*))?$/u.exec(suffix);
  const from = Number(match?.[1]),
    to = Number(match?.[2] ?? match?.[1]);
  if (!match || !Number.isSafeInteger(to) || from > to)
    throw new StashError('STASH_INVALID_DATA', '无效事件范围', { kind: 'event-window' });
  return { id, explicit, view: 'events', window: { from, to } };
}

function shortBase(id: string): string {
  return id.replace(/^session-/u, '');
}

export function shortSessionId(id: string, ids: readonly string[]): string {
  const base = shortBase(id);
  for (let n = Math.min(8, base.length); n <= base.length; n++) {
    const prefix = base.slice(0, n);
    if (ids.filter((other) => shortBase(other).startsWith(prefix)).length === 1) return prefix;
  }
  return id;
}

export function resolveSessionId(value: string, ids: readonly string[]): string {
  if (ids.includes(value)) return value;
  const matches = ids.filter((id) => shortBase(id).startsWith(value));
  if (!matches.length)
    throw new StashError('STASH_NOT_FOUND', '会话不在当前工作区', { kind: 'session-not-found' });
  if (matches.length > 1)
    throw new StashError('STASH_AMBIGUOUS_REF', '会话 ID 不唯一', {
      kind: 'ambiguous-session',
      candidates: matches,
    });
  return matches[0]!;
}
