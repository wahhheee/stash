import { parseDocument, stringify } from 'yaml';
import { StashError } from './errors.ts';

export interface Note {
  fields: Record<string, unknown>;
  body: string;
}

export function frontmatter(text: string): Note {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (!match) {
    if (/^---\r?\n/u.test(text)) throw new StashError('STASH_INVALID_DATA', 'frontmatter 未闭合');
    return { fields: {}, body: text };
  }
  const doc = parseDocument(match[1]!, { uniqueKeys: true });
  if (doc.errors.length) throw new StashError('STASH_INVALID_DATA', 'frontmatter 格式错误');
  const fields: unknown = doc.toJS({ maxAliasCount: 0 });
  if (!fields || typeof fields !== 'object' || Array.isArray(fields))
    throw new StashError('STASH_INVALID_DATA', 'frontmatter 必须为映射');
  return { fields: fields as Record<string, unknown>, body: text.slice(match[0].length) };
}

export function parseNote(text: string): Note {
  const note = frontmatter(text);
  for (const key of ['type', 'description']) {
    const value = note.fields[key];
    if (typeof value !== 'string' || !value.trim() || /[\r\n]/u.test(value))
      throw new StashError('STASH_INVALID_DATA', '笔记需要单行 type 和 description');
  }
  if (note.fields.index !== undefined && typeof note.fields.index !== 'boolean')
    throw new StashError('STASH_INVALID_DATA', 'index 必须为布尔值');
  if (note.fields.status !== undefined && typeof note.fields.status !== 'string')
    throw new StashError('STASH_INVALID_DATA', 'status 必须为文字');
  return note;
}

export function archiveNote(text: string): string {
  const note = parseNote(text);
  return '---\n' + stringify({ ...note.fields, status: 'archived' }) + '---\n' + note.body;
}
