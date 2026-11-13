import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { containsSecret } from './redaction.ts';
import { auditSchema } from './memory-records.ts';
import { memoryPath, StashError } from '@wahhheee/stash-core';
import type { MemoryChange, MemoryFile, MemoryStore } from '@wahhheee/stash-core';

const fileSchema = z.object({ content: z.string(), revision: z.string() }).strict();

const changeSchema = z
  .object({
    v: z.literal(1),
    id: z.string(),
    workspaceId: z.string(),
    path: z.string(),
    before: fileSchema.nullable(),
    after: fileSchema.nullable(),
    timestamp: z.iso.datetime(),
    actor: z.string(),
    callId: z.string(),
    op: z.string(),
  })
  .strict();

export type JournalChange = z.infer<typeof changeSchema>;

export const workspaceSchema = z
  .object({ format: z.literal(1), id: z.string(), path: z.string(), title: z.string() })
  .strict();

export type WorkspaceInfo = z.infer<typeof workspaceSchema>;

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function memoryFile(content: string): MemoryFile {
  return { content, revision: digest(content) };
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** 普通文件读取拒绝链接及超大输入。 */
async function readOptional(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
      throw new StashError('STASH_INVALID_DATA', '记忆文件不是普通文件或过大');
    return await readFile(path, 'utf8');
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

async function atomic(path: string, text: string): Promise<void> {
  const temp = join(dirname(path), '.tmp-' + randomUUID());
  const file = await open(temp, 'wx', 0o600);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

/** 工作区锁覆盖扫描、预算验证、版本比较、文件替换与日志提交。 */
export class FileMemoryStore implements MemoryStore {
  constructor(readonly root: string) {}

  directory(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(id) || /^(con|prn|aux|nul|com\d|lpt\d)$/iu.test(id))
      throw new StashError('STASH_INVALID_DATA', '无效工作区 ID');
    return join(this.root, id);
  }

  private async safe(path: string, create = false): Promise<void> {
    const root = resolve(this.root);
    const rel = relative(root, resolve(path));
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new StashError('STASH_INVALID_DATA', '路径越界');
    let current = root;
    for (const part of ['', ...rel.split(/[\\/]/u).filter(Boolean)]) {
      current = join(current, part);
      try {
        const st = await lstat(current);
        if (st.isSymbolicLink() || !st.isDirectory())
          throw new StashError('STASH_INVALID_DATA', '目录包含链接或非目录');
      } catch (error) {
        if (!missing(error)) throw error;
        if (create) await mkdir(current, { recursive: true });
        else return;
      }
    }
  }

  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    const dir = this.directory(id);
    await this.safe(dir, true);
    const path = join(dir, '.lock');
    const deadline = Date.now() + 5000;
    let handle;
    while (!handle) {
      try {
        handle = await open(path, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (Date.now() >= deadline)
          throw new StashError('STASH_LOCKED', '工作区锁超时；确认无活动进程后人工移除锁文件');
        await setTimeout(25);
      }
    }
    try {
      await handle.writeFile(JSON.stringify({ format: 1, pid: process.pid }));
      return await action();
    } finally {
      await handle.close();
      await unlink(path);
    }
  }

  async ensure(info: WorkspaceInfo): Promise<void> {
    await this.locked(info.id, async () => {
      const path = join(this.directory(info.id), 'workspace.json');
      const old = await readOptional(path);
      if (old !== null) {
        const parsed = workspaceSchema.parse(JSON.parse(old));
        if (parsed.id !== info.id) throw new StashError('STASH_INVALID_DATA', '工作区标识不符');
      }
      if (old !== JSON.stringify(info)) await atomic(path, JSON.stringify(info));
      await this.recover(info.id);
    });
  }

  async read(id: string, path: string): Promise<MemoryFile | null> {
    memoryPath(path, true);
    const target = join(this.directory(id), path.slice(1));
    await this.safe(dirname(target));
    const text = await readOptional(target);
    return text === null ? null : memoryFile(text);
  }

  async list(id: string): Promise<string[]> {
    const paths: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      await this.safe(dir);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (missing(error)) return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new StashError('STASH_INVALID_DATA', '记忆目录包含链接');
        const path = prefix + entry.name;
        if (entry.isDirectory() && (prefix !== '/' || entry.name === 'notes'))
          await walk(join(dir, entry.name), path + '/');
        else if (
          entry.isFile() &&
          (path === '/RULES.md' || (prefix.startsWith('/notes/') && path.endsWith('.md')))
        )
          paths.push(memoryPath(path, true));
      }
    };
    await walk(this.directory(id), '/');
    if (new Set(paths.map((p) => p.toLowerCase())).size !== paths.length)
      throw new StashError('STASH_INVALID_DATA', '路径大小写冲突');
    return paths.sort();
  }

  async journal(id: string): Promise<JournalChange[]> {
    await this.safe(this.directory(id));
    const text = await readOptional(join(this.directory(id), '.journal.jsonl'));
    const result = (text ?? '')
      .split('\n')
      .filter(Boolean)
      .map((line) => changeSchema.parse(JSON.parse(line)));
    const states = new Map<string, MemoryFile | null>();
    const ids = new Set<string>();
    for (const change of result) {
      memoryPath(change.path, true);
      if (
        change.workspaceId !== id ||
        ids.has(change.id) ||
        (states.get(change.path)?.revision ?? null) !== (change.before?.revision ?? null)
      )
        throw new StashError('STASH_INVALID_DATA', '修改日志链损坏');
      for (const file of [change.before, change.after])
        if (file && digest(file.content) !== file.revision)
          throw new StashError('STASH_INVALID_DATA', '修改日志哈希损坏');
      ids.add(change.id);
      states.set(change.path, change.after);
    }
    return result;
  }

  private async append(id: string, change: JournalChange): Promise<void> {
    const path = join(this.directory(id), '.journal.jsonl');
    const before = (await readOptional(path)) ?? '';
    await atomic(path, before + JSON.stringify(change) + '\n');
  }

  private async recover(id: string): Promise<void> {
    const pending = join(this.directory(id), '.pending.json');
    const raw = await readOptional(pending);
    if (raw === null) return;
    const change = changeSchema.parse(JSON.parse(raw));
    if (change.workspaceId !== id)
      throw new StashError('STASH_INVALID_DATA', '待提交记录工作区不符');
    for (const f of [change.before, change.after])
      if (f && digest(f.content) !== f.revision)
        throw new StashError('STASH_INVALID_DATA', '待提交记录哈希错误');
    const journal = await this.journal(id);
    const current = await this.read(id, change.path);
    if (!journal.some((c) => c.id === change.id)) {
      const revision = current?.revision ?? null;
      if (
        revision !== (change.before?.revision ?? null) &&
        revision !== (change.after?.revision ?? null)
      )
        throw new StashError('STASH_STALE_READ', '恢复期间发现外部修改');
      await this.replace(id, change.path, change.after?.content ?? null);
      await this.append(id, change);
    }
    await unlink(pending);
  }

  private async replace(id: string, path: string, content: string | null): Promise<void> {
    const target = join(this.directory(id), memoryPath(path, true).slice(1));
    await this.safe(dirname(target), true);
    await readOptional(target);
    if (content === null)
      await unlink(target).catch((error) => {
        if (!missing(error)) throw error;
      });
    else await atomic(target, content);
  }

  private async scan(id: string, recordExternal: boolean): Promise<Map<string, string>> {
    const files = new Map<string, string>();
    for (const path of await this.list(id)) {
      const file = await this.read(id, path);
      if (file) {
        if (containsSecret(file.content)) throw new StashError('STASH_SECRET', '外部文件包含凭据');
        files.set(path, file.content);
      }
    }
    if (recordExternal) {
      const previous = new Map<string, MemoryFile | null>();
      for (const c of await this.journal(id)) previous.set(c.path, c.after);
      for (const path of new Set([...files.keys(), ...previous.keys()])) {
        const before = previous.get(path) ?? null;
        const after = files.has(path) ? memoryFile(files.get(path)!) : null;
        if (before?.revision !== after?.revision)
          await this.append(id, {
            v: 1,
            id: randomUUID(),
            workspaceId: id,
            path,
            before,
            after,
            timestamp: new Date().toISOString(),
            actor: 'external',
            callId: '',
            op: 'external',
          });
      }
    }
    return files;
  }

  async validateWorkspace(id: string): Promise<void> {
    await this.safe(this.directory(id));
    const raw = await readOptional(join(this.directory(id), 'workspace.json'));
    if (raw !== null && workspaceSchema.parse(JSON.parse(raw)).id !== id)
      throw new StashError('STASH_INVALID_DATA', '工作区标识不符');
  }

  async observe(id: string): Promise<{ files: Map<string, string>; journalId: string | null }> {
    return this.locked(id, async () => {
      await this.validateWorkspace(id);
      await this.recover(id);
      const files = await this.scan(id, true);
      return { files, journalId: (await this.journal(id)).at(-1)?.id ?? null };
    });
  }

  async audit(id: string, sessionId: string, record: unknown): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId))
      throw new StashError('STASH_INVALID_DATA', '会话 ID 无效');
    await this.locked(id, async () => {
      const path = join(this.directory(id), '.decisions-' + sessionId + '.jsonl');
      const previous = (await readOptional(path)) ?? '';
      for (const line of previous.split('\n').filter(Boolean)) auditSchema.parse(JSON.parse(line));
      await atomic(path, previous + JSON.stringify(auditSchema.parse(record)) + '\n');
    });
  }

  async snapshot(id: string, readOnly = false): Promise<Map<string, string>> {
    await this.validateWorkspace(id);
    if (readOnly) return this.scan(id, false);
    return this.locked(id, async () => {
      await this.recover(id);
      return this.scan(id, true);
    });
  }

  async transact<T>(
    id: string,
    path: string,
    expected: string | null | undefined,
    actor: string,
    callId: string,
    op: string,
    transform: (files: Map<string, string>) => { content: string | null; value: T },
  ): Promise<T> {
    return this.locked(id, async () => {
      memoryPath(path, true);
      await this.validateWorkspace(id);
      await this.recover(id);
      const files = await this.scan(id, true);
      if ([...files.keys()].some((p) => p !== path && p.toLowerCase() === path.toLowerCase()))
        throw new StashError('STASH_INVALID_DATA', '路径大小写冲突');
      const before = files.has(path) ? memoryFile(files.get(path)!) : null;
      if (expected !== undefined && expected !== (before?.revision ?? null))
        throw new StashError('STASH_STALE_READ', '文件已变化');
      const result = transform(files);
      if (result.content !== null && containsSecret(result.content))
        throw new StashError('STASH_SECRET', '禁止保存凭据');
      const after = result.content === null ? null : memoryFile(result.content);
      const change: JournalChange = {
        v: 1,
        id: randomUUID(),
        workspaceId: id,
        path,
        before,
        after,
        timestamp: new Date().toISOString(),
        actor,
        callId,
        op,
      };
      const pending = join(this.directory(id), '.pending.json');
      await atomic(pending, JSON.stringify(change));
      await this.replace(id, path, result.content);
      await this.append(id, change);
      await unlink(pending);
      return result.value;
    });
  }

  async write(
    id: string,
    path: string,
    content: string | null,
    expectedRevision: string | null,
  ): Promise<MemoryChange> {
    const callId = randomUUID();
    await this.transact(id, path, expectedRevision, 'api', callId, 'write', () => ({
      content,
      value: undefined,
    }));
    return (await this.journal(id)).find((change) => change.callId === callId)!;
  }
}
