import { StashError } from './errors.ts';

/** 只接受可跨平台原样落盘的工作区路径。 */
export function memoryPath(path: string, writable = false): string {
  if (path.startsWith('./') || path.startsWith('../') || path.startsWith('/sessions'))
    throw new StashError('STASH_UNSUPPORTED', '当前只支持工作区记忆');
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
