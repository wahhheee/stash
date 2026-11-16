import { StashError } from './errors.ts';
import { sessionId } from './refs.ts';

export function sessionMemoryTarget(
  path: string,
  current: string,
): { id: string; path: string; explicit: boolean; writable: boolean } | null {
  if (path.startsWith('./') && !/^\.\/log(?:\/|$)/u.test(path))
    return {
      id: sessionId(current),
      path: memoryPath(path.slice(1)),
      explicit: true,
      writable: true,
    };
  const match =
    /^(?:\.\.\/|\/sessions\/|dsh:\/\/session\/)([^/]+)\/(RULES\.md|notes(?:\/.*)?|)$/u.exec(path);
  if (!match) return null;
  return {
    id: sessionId(match[1]!),
    path: memoryPath('/' + match[2]!),
    explicit: path.startsWith('dsh://'),
    writable: false,
  };
}

/** 只接受作用域内部的规范路径；工作区路径可跨平台原样落盘。 */
export function memoryPath(path: string, writable = false): string {
  if (path.startsWith('./') || path.startsWith('../') || path.startsWith('/sessions'))
    throw new StashError('STASH_UNSUPPORTED', '会话路径须先解析作用域');
  if (
    !path.startsWith('/') ||
    /[\\:%]/u.test(path) ||
    [...path].some((char) => char.charCodeAt(0) < 32)
  )
    throw new StashError('STASH_INVALID_DATA', '无效路径');
  if (!writable && ['/', '/notes', '/notes/', '/.guide.md'].includes(path)) return path;
  const parts = path.slice(1).replace(/\/$/u, '').split('/');
  if (
    parts.some(
      (p) =>
        !p ||
        p === '.' ||
        p === '..' ||
        /[ .]$/u.test(p) ||
        /[<>"|?*]/u.test(p) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(p),
    )
  )
    throw new StashError('STASH_INVALID_DATA', '无效路径');
  if (path === '/RULES.md') return path;
  if (
    parts[0] === 'notes' &&
    parts.length > 1 &&
    (path.endsWith('.md') || (!writable && path.endsWith('/')))
  )
    return path;
  throw new StashError('STASH_UNSUPPORTED', '不支持此记忆路径');
}
