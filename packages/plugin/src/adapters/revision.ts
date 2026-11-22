import { createHash } from 'node:crypto';
import type { MemoryFile } from '@wahhheee/stash-core';

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function memoryFile(content: string): MemoryFile {
  return { content, revision: digest(content) };
}

export function snapshotRevision(files: ReadonlyMap<string, string>): string {
  return digest(JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}
