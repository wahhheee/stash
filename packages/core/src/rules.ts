import { StashError } from './errors.ts';
import { frontmatter, parseNote } from './notes.ts';
import { memoryPath } from './namespace.ts';

export function expandRules(files: ReadonlyMap<string, string>): string {
  const rules = frontmatter(files.get('/RULES.md') ?? '');
  if ('paths' in rules.fields)
    throw new StashError('STASH_UNSUPPORTED', '不支持路径作用域规则', { kind: 'rules-paths' });
  return rules.body
    .split(/\r?\n/u)
    .map((line) => {
      if (!line.startsWith('@')) return line;
      const path = memoryPath('/' + line.slice(1).trim(), true);
      if (!path.startsWith('/notes/'))
        throw new StashError('STASH_INVALID_DATA', '只能并入笔记', { kind: 'rules-import' });
      const text = files.get(path);
      if (text === undefined)
        throw new StashError('STASH_NOT_FOUND', '并入的笔记不存在', { kind: 'rules-import' });
      return parseNote(text).body;
    })
    .join('\n')
    .replace(/<!--\s*src:[\s\S]*?-->/gu, '')
    .trim();
}
