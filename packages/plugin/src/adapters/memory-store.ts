import { ledger } from './maintenance-ledger.ts';
import type { Stats } from './maintenance-ledger.ts';
import { runId, draftSchema, statsSchema } from './maintenance-schema.ts';
import type { MaintenanceMode, StageDraft } from './maintenance-schema.ts';
import { fileChanges, editStage, stagePreview, validateStagePaths } from './stage-files.ts';
import type { StageEdit } from './stage-files.ts';
import { resolveRedirect, previewPlan, notePath } from '@wahhheee/stash-core';
import type { PlanChange, PlanPreview } from '@wahhheee/stash-core';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink, link } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { z } from 'zod';
import { switchSchema } from './page-schema.ts';
import type { SwitchRecord } from '@wahhheee/stash-core';
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
    group: runId.optional(),
    redirect: z.string().optional(),
  })
  .strict();

export type JournalChange = z.infer<typeof changeSchema>;

export const workspaceSchema = z
  .object({
    format: z.literal(1),
    id: z.string(),
    path: z.string(),
    title: z.string(),
    switches: switchSchema.optional(),
  })
  .strict();

export type WorkspaceInfo = z.infer<typeof workspaceSchema>;

export function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function memoryFile(content: string): MemoryFile {
  return { content, revision: digest(content) };
}

export function snapshotRevision(files: ReadonlyMap<string, string>): string {
  return digest(JSON.stringify([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}

interface CachedFile {
  mtimeMs: number;
  size: number;
  file: MemoryFile;
}

interface JournalCache {
  mtimeMs: number | null;
  size: number;
  changes: JournalChange[];
  states: Map<string, MemoryFile | null>;
  ids: Set<string>;
  terminated: boolean;
  aliases?: Map<string, string>;
}

interface WorkspaceCache {
  files: Map<string, CachedFile>;
  journal?: JournalCache;
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
  if (Buffer.byteLength(text) > 32 * 1024 * 1024)
    throw new StashError('STASH_INVALID_DATA', '写入内容超过 32 MiB', { kind: 'storage-size' });
  const temp = join(dirname(path), '.tmp-' + randomUUID());
  const file = await open(temp, 'wx', 0o600);
  try {
    try {
      await file.writeFile(text, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await unlink(temp).catch((error) => {
      if (!missing(error)) throw error;
    });
  }
}

/** 工作区锁覆盖扫描、预算验证、版本比较、文件替换与日志提交。 */
export class FileMemoryStore implements MemoryStore {
  private readonly workspaces = new Map<string, WorkspaceCache>();

  constructor(readonly root: string) {}

  private cache(id: string): WorkspaceCache {
    let cache = this.workspaces.get(id);
    if (!cache) {
      cache = { files: new Map() };
      this.workspaces.set(id, cache);
    }
    return cache;
  }

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
      let switches: SwitchRecord | undefined;
      if (old !== null) {
        const parsed = workspaceSchema.parse(JSON.parse(old));
        switches = parsed.switches;
        if (parsed.id !== info.id) throw new StashError('STASH_INVALID_DATA', '工作区标识不符');
      }
      const next = JSON.stringify({ ...info, ...(switches ? { switches } : {}) });
      if (old !== next) await atomic(path, next);
      await this.recover(info.id);
    });
  }

  async getSwitches(id: string): Promise<SwitchRecord | null> {
    await this.safe(this.directory(id));
    const text = await readOptional(join(this.directory(id), 'workspace.json'));
    if (text === null) return null;
    const info = workspaceSchema.parse(JSON.parse(text));
    if (info.id !== id) throw new StashError('STASH_INVALID_DATA', '工作区标识不符');
    return info.switches ?? null;
  }

  async setSwitches(id: string, value: SwitchRecord): Promise<void> {
    await this.locked(id, async () => {
      const path = join(this.directory(id), 'workspace.json');
      const info = workspaceSchema.parse(JSON.parse((await readOptional(path)) ?? 'null'));
      if (info.id !== id) throw new StashError('STASH_INVALID_DATA', '工作区标识不符');
      await atomic(path, JSON.stringify({ ...info, switches: switchSchema.parse(value) }));
    });
  }

  async read(id: string, path: string): Promise<MemoryFile | null> {
    return this.readCached(id, path, true);
  }

  /** 显式读取和写前校验绕过缓存；请求扫描只重读元数据有变化的文件。 */
  private async readCached(id: string, path: string, fresh = false): Promise<MemoryFile | null> {
    memoryPath(path, true);
    const target = join(this.directory(id), path.slice(1));
    await this.safe(dirname(target));
    const files = this.cache(id).files;
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
        throw new StashError('STASH_INVALID_DATA', '记忆文件不是普通文件或过大');
      const cached = files.get(path);
      if (!fresh && cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size)
        return cached.file;
      const file = memoryFile(
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(target)),
      );
      if (containsSecret(file.content)) throw new StashError('STASH_SECRET', '外部文件包含凭据');
      files.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, file });
      return file;
    } catch (error) {
      files.delete(path);
      if (missing(error)) return null;
      throw error;
    }
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
    return (await this.loadJournal(id, true)).changes.slice();
  }

  private async loadJournal(id: string, fresh = false): Promise<JournalCache> {
    await this.safe(this.directory(id));
    const path = join(this.directory(id), '.journal.jsonl');
    const cache = this.cache(id);
    let stat;
    try {
      stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024 * 1024)
        throw new StashError('STASH_INVALID_DATA', '修改日志不是普通文件或过大');
    } catch (error) {
      if (!missing(error)) throw error;
    }
    if (
      !fresh &&
      cache.journal?.mtimeMs === (stat?.mtimeMs ?? null) &&
      cache.journal.size === (stat?.size ?? 0)
    )
      return cache.journal;
    const text = stat ? await readFile(path, 'utf8') : '';
    const journal = this.parseJournal(id, text);
    journal.mtimeMs = stat?.mtimeMs ?? null;
    journal.size = stat?.size ?? 0;
    cache.journal = journal;
    return journal;
  }

  private parseJournal(id: string, text: string): JournalCache {
    const changes = text
      .split('\n')
      .filter(Boolean)
      .map((line) => changeSchema.parse(JSON.parse(line)));
    const journal: JournalCache = {
      mtimeMs: null,
      size: 0,
      changes: [],
      states: new Map(),
      ids: new Set(),
      terminated: !text || text.endsWith('\n'),
    };
    for (const change of changes) this.acceptChange(id, journal, change);
    return journal;
  }

  private validateChange(id: string, change: JournalChange): void {
    memoryPath(change.path, true);
    if (
      Boolean(change.group) !== ['maintenance', 'rollback'].includes(change.op) ||
      (change.group && (change.group !== change.actor || change.group !== change.callId)) ||
      (change.redirect &&
        (!change.group ||
          (change.op === 'maintenance'
            ? change.after !== null || change.before === null
            : change.before !== null || change.after === null)))
    )
      throw new StashError('STASH_INVALID_DATA', '整理日志标识或跳转记录无效');
    if (change.redirect) {
      notePath(change.path);
      notePath(change.redirect);
    }
    if (change.workspaceId !== id) throw new StashError('STASH_INVALID_DATA', '修改日志工作区不符');
    for (const file of [change.before, change.after]) {
      if (file && digest(file.content) !== file.revision)
        throw new StashError('STASH_INVALID_DATA', '修改日志哈希损坏');
      if (file && containsSecret(file.content))
        throw new StashError('STASH_SECRET', '修改记录包含凭据');
    }
  }

  private acceptChange(id: string, journal: JournalCache, change: JournalChange): void {
    this.validateChange(id, change);
    if (
      journal.ids.has(change.id) ||
      (journal.states.get(change.path)?.revision ?? null) !== (change.before?.revision ?? null)
    )
      throw new StashError('STASH_INVALID_DATA', '修改日志链损坏');
    if (change.group || change.callId === 'clear') delete journal.aliases;
    journal.changes.push(change);
    journal.ids.add(change.id);
    journal.states.set(change.path, change.after);
  }

  private async append(id: string, change: JournalChange): Promise<void> {
    const path = join(this.directory(id), '.journal.jsonl');
    const journal = await this.loadJournal(id);
    const text = this.appendText(journal, change);
    this.acceptChange(id, journal, change);
    try {
      const file = await open(path, 'a', 0o600);
      try {
        await file.writeFile(text, 'utf8');
        await file.sync();
        const stat = await file.stat();
        journal.mtimeMs = stat.mtimeMs;
        journal.size = stat.size;
        journal.terminated = true;
      } finally {
        await file.close();
      }
    } catch (error) {
      delete this.cache(id).journal;
      throw error;
    }
  }

  private appendText(journal: JournalCache, change: JournalChange): string {
    const text = (journal.terminated ? '' : '\n') + JSON.stringify(change) + '\n';
    if (journal.size + Buffer.byteLength(text) > 32 * 1024 * 1024)
      throw new StashError('STASH_INVALID_DATA', '修改日志超过 32 MiB', { kind: 'storage-size' });
    return text;
  }

  /** 只有 pending 能证明归属的尾部残片才允许修复；已完成的行始终严格校验。 */
  private async recoverJournal(id: string, change: JournalChange): Promise<JournalCache> {
    const path = join(this.directory(id), '.journal.jsonl');
    const raw = await readOptional(path);
    if (raw === null || raw.endsWith('\n') || raw === '') return this.loadJournal(id, true);
    const bytes = await readFile(path);
    const end = bytes.lastIndexOf(10) + 1;
    const prefix = bytes.subarray(0, end);
    const tail = bytes.subarray(end);
    const journal = this.parseJournal(id, prefix.toString('utf8'));
    const expected = Buffer.from(JSON.stringify(change) + '\n');
    // 完整且有效的旧日志允许没有末尾换行；追加时补上分隔符。
    try {
      JSON.parse(tail.toString('utf8'));
    } catch {
      if (tail.length >= expected.length || !tail.equals(expected.subarray(0, tail.length)))
        throw new StashError('STASH_INVALID_DATA', '日志尾部与待提交记录不符');
      this.acceptChange(id, journal, change);
      const file = await open(path, 'r+');
      try {
        await file.truncate(end);
        await file.sync();
      } finally {
        await file.close();
      }
      delete this.cache(id).journal;
      return this.loadJournal(id, true);
    }
    return this.loadJournal(id, true);
  }

  private async recover(id: string) {
    const path = join(this.directory(id), '.batch.json');
    const raw = await readOptional(path);
    if (raw === null) return this.recoverOne(id);
    const batch = z
      .object({ v: z.literal(1), changes: z.array(changeSchema).min(1) })
      .strict()
      .parse(JSON.parse(raw));
    const first = batch.changes[0]!;
    if (
      new Set(batch.changes.map((c) => c.path.toLowerCase())).size !== batch.changes.length ||
      new Set(batch.changes.map((c) => c.id)).size !== batch.changes.length
    )
      throw new StashError('STASH_INVALID_DATA', '整理恢复记录重复');
    for (const c of batch.changes) {
      this.validateChange(id, c);
      if (!c.group || c.group !== first.group || c.op !== first.op)
        throw new StashError('STASH_INVALID_DATA', '整理恢复记录无效');
    }
    const single = await readOptional(join(this.directory(id), '.pending.json'));
    if (single !== null) {
      const change = changeSchema.parse(JSON.parse(single));
      if (!batch.changes.some((c) => JSON.stringify(c) === JSON.stringify(change)))
        throw new StashError('STASH_INVALID_DATA', '待提交记录不属于整理组');
      await this.recoverOne(id);
    }
    const journal = await this.loadJournal(id);
    for (const c of batch.changes) {
      const recorded = journal.ids.has(c.id);
      const expected = recorded ? c.after : c.before;
      if (
        !recorded &&
        (journal.states.get(c.path)?.revision ?? null) !== (c.before?.revision ?? null)
      )
        throw new StashError('STASH_INVALID_DATA', '整理记录与日志链不符');
      if (((await this.read(id, c.path))?.revision ?? null) !== (expected?.revision ?? null))
        throw new StashError('STASH_STALE_READ', '整理期间发现外部修改');
      if (
        recorded &&
        JSON.stringify(journal.changes.find((x) => x.id === c.id)) !== JSON.stringify(c)
      )
        throw new StashError('STASH_INVALID_DATA', '整理日志不一致');
    }
    for (const c of batch.changes) {
      if (journal.ids.has(c.id)) continue;
      await atomic(join(this.directory(id), '.pending.json'), JSON.stringify(c));
      await this.replace(id, c.path, c.after?.content ?? null);
      await this.append(id, c);
      await unlink(join(this.directory(id), '.pending.json'));
    }
    await unlink(path);
  }

  private async recoverOne(id: string): Promise<void> {
    const pending = join(this.directory(id), '.pending.json');
    const raw = await readOptional(pending);
    if (raw === null) return;
    const change = changeSchema.parse(JSON.parse(raw));
    this.validateChange(id, change);
    const current = await this.read(id, change.path);
    const revision = current?.revision ?? null;
    if (
      revision !== (change.before?.revision ?? null) &&
      revision !== (change.after?.revision ?? null)
    )
      throw new StashError('STASH_STALE_READ', '恢复期间发现外部修改', {
        kind: 'recovery-conflict',
      });
    const journal = await this.recoverJournal(id, change);
    const recorded = journal.changes.find((c) => c.id === change.id);
    if (recorded && JSON.stringify(recorded) !== JSON.stringify(change))
      throw new StashError('STASH_INVALID_DATA', '待提交记录与日志不符');
    if (recorded && revision !== (change.after?.revision ?? null))
      throw new StashError('STASH_STALE_READ', '已提交文件在恢复前被改写', {
        kind: 'recovery-conflict',
      });
    if (!recorded) {
      this.appendText(journal, change);
      if ((journal.states.get(change.path)?.revision ?? null) !== (change.before?.revision ?? null))
        throw new StashError('STASH_INVALID_DATA', '待提交记录与日志链不符');
      await this.replace(id, change.path, change.after?.content ?? null);
      await this.append(id, change);
    }
    await unlink(pending);
  }

  private async replace(id: string, path: string, content: string | null): Promise<void> {
    this.cache(id).files.delete(path);
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
    const files = new Map<string, MemoryFile>();
    for (const path of await this.list(id)) {
      const file = await this.readCached(id, path, !recordExternal);
      if (file) files.set(path, file);
    }
    for (const path of this.cache(id).files.keys())
      if (!files.has(path)) this.cache(id).files.delete(path);
    const journal = await this.loadJournal(id);
    const aliases = (journal.aliases ??= ledger(journal.changes).aliases);
    const fileNames = new Set([...files.keys()].map((p) => p.toLowerCase()));
    for (const [from, to] of aliases)
      if (fileNames.has(from.toLowerCase()) || !files.has(resolveRedirect(to, aliases)))
        throw new StashError('STASH_STALE_READ', '旧路径被占用或合并目标不存在');
    if (recordExternal) {
      const previous = (await this.loadJournal(id)).states;
      for (const path of new Set([...files.keys(), ...previous.keys()])) {
        const before = previous.get(path) ?? null;
        const after = files.get(path) ?? null;
        if (before?.revision !== after?.revision) {
          const change: JournalChange = {
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
          };
          this.appendText(await this.loadJournal(id), change);
          const pending = join(this.directory(id), '.pending.json');
          await atomic(pending, JSON.stringify(change));
          await this.append(id, change);
          await unlink(pending);
        }
      }
    }
    return new Map([...files].map(([path, file]) => [path, file.content]));
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
      return { files, journalId: (await this.loadJournal(id)).changes.at(-1)?.id ?? null };
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
    if (readOnly) {
      await this.checkBatch(id);
      const head = (await this.loadJournal(id)).changes.at(-1)?.id;
      const files = await this.scan(id, false);
      await this.checkBatch(id);
      if (head !== (await this.loadJournal(id)).changes.at(-1)?.id)
        throw new StashError('STASH_STALE_READ', '读取期间记忆已变化');
      return files;
    }
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
      // 即使外部工具保持 mtime 与大小，写前也必须检查目标文件的真实内容。
      await this.read(id, path);
      const files = await this.scan(id, true);
      if ([...files.keys()].some((p) => p !== path && p.toLowerCase() === path.toLowerCase()))
        throw new StashError('STASH_INVALID_DATA', '路径大小写冲突', { kind: 'path-case' });
      const aliases = await this.aliases(id);
      if ([...aliases.keys()].some((p) => p.toLowerCase() === path.toLowerCase()))
        throw new StashError('STASH_ALREADY_EXISTS', '旧路径保留作跳转', {
          kind: 'maintenance-alias',
        });
      const before = files.has(path) ? memoryFile(files.get(path)!) : null;
      if (op === 'create' && expected === null && before !== null)
        throw new StashError('STASH_ALREADY_EXISTS', '文件已存在');
      if (expected !== undefined && expected !== (before?.revision ?? null))
        throw new StashError('STASH_STALE_READ', '文件已变化');
      const result = transform(files);
      if (result.content === null && [...aliases.values()].includes(path))
        throw new StashError('STASH_UNSUPPORTED', '仍有旧路径引用此笔记，请归档或再合并', {
          kind: 'maintenance-alias',
        });
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
      this.appendText(await this.loadJournal(id), change);
      await atomic(pending, JSON.stringify(change));
      await this.replace(id, path, result.content);
      await this.append(id, change);
      await unlink(pending);
      return result.value;
    });
  }

  private async checkBatch(id: string) {
    if ((await readOptional(join(this.directory(id), '.batch.json'))) !== null)
      throw new StashError('STASH_LOCKED', '正在整理，稍后重试');
  }

  async aliases(id: string) {
    await this.checkBatch(id);
    const journal = await this.loadJournal(id);
    return new Map((journal.aliases ??= ledger(journal.changes).aliases));
  }

  async readNote(id: string, path: string) {
    return this.locked(id, async () => {
      await this.validateWorkspace(id);
      await this.recover(id);
      const resolved = resolveRedirect(notePath(path), await this.aliases(id));
      if (resolved !== path && (await this.read(id, path)))
        throw new StashError('STASH_STALE_READ', '重定向路径出现同名文件');
      const file = await this.read(id, resolved);
      return { path: resolved, file };
    });
  }

  private async stats(id: string): Promise<Stats> {
    const text = await readOptional(join(this.directory(id), '.stats.json'));
    return text === null ? { v: 1, notes: {} } : statsSchema.parse(JSON.parse(text));
  }

  async recordRead(id: string, path: string, revision: string) {
    await this.locked(id, async () => {
      await this.recover(id);
      const file = await this.read(id, path);
      if (file?.revision !== revision)
        throw new StashError('STASH_STALE_READ', '读取期间笔记已变化');
      const stats = await this.stats(id);
      const journal = await this.loadJournal(id);
      if (journal.states.get(path)?.revision !== revision) await this.scan(id, true);
      const fact = ledger((await this.loadJournal(id)).changes).usage.get(path)!;
      const old = stats.notes[path];
      stats.notes[path] = {
        ...fact,
        reads: (old?.created === fact.created ? old.reads : 0) + 1,
        lastRead: new Date().toISOString(),
      };
      await atomic(join(this.directory(id), '.stats.json'), JSON.stringify(stats));
    });
  }

  private draftPath(id: string, group: string) {
    return join(this.directory(id), '.plan-' + runId.parse(group) + '.json');
  }

  private async draft(id: string, group: string) {
    const raw = await readOptional(this.draftPath(id, group));
    if (raw === null) throw new StashError('STASH_NOT_FOUND', '整理会话不存在');
    if (containsSecret(raw)) throw new StashError('STASH_SECRET', '整理草稿包含凭据');
    const draft = draftSchema.parse(JSON.parse(raw));
    if (draft.workspaceId !== id || draft.id !== group)
      throw new StashError('STASH_INVALID_DATA', '整理记录身份不符');
    return draft;
  }

  private async catalog(id: string) {
    const ids = (await readdir(this.directory(id)))
      .filter((p) => p.startsWith('.plan-') && p.endsWith('.json'))
      .map((p) => p.slice(6, -5));
    const drafts = [];
    for (const group of ids) drafts.push(await this.draft(id, group));
    return drafts;
  }

  async verifyMaintenance(id: string) {
    await this.checkBatch(id);
    for (const d of await this.catalog(id))
      if (d.v === 3) {
        const trees = new FileMemoryStore(join(this.directory(id), '.staging', d.id));
        await this.safe(trees.root);
        await this.readTree(trees, d.base);
        validateStagePaths(await this.readTree(trees, d.working), new Map(d.redirects));
      }
    await this.stats(id);
    const aliases = await this.aliases(id);
    for (const [from, to] of aliases)
      if ((await this.read(id, from)) || !(await this.read(id, resolveRedirect(to, aliases))))
        throw new StashError('STASH_INVALID_DATA', '重定向存在冲突或目标缺失');
  }

  async maintenanceState(id: string) {
    return this.locked(id, async () => {
      await this.validateWorkspace(id);
      await this.recover(id);
      const files = await this.scan(id, true);
      const journal = await this.loadJournal(id);
      const state = ledger(journal.changes);
      const stats = await this.stats(id);
      for (const [p, usage] of state.usage) {
        const read = stats.notes[p];
        if (read?.created === usage.created) {
          usage.reads = read.reads;
          usage.lastRead = read.lastRead;
        }
      }
      const base = snapshotRevision(files);
      const runs = (await this.catalog(id)).map((d) => ({
        id: d.id,
        mode: d.mode,
        ...(d.v === 3 &&
        d.submitted &&
        d.working !== d.base &&
        !state.groups.has(d.id) &&
        base === d.base
          ? { revision: d.submitted }
          : {}),
        status:
          state.groups.get(d.id) ??
          (base !== d.base
            ? ('stale' as const)
            : d.v === 3 && d.submitted && d.working === d.base
              ? ('unchanged' as const)
              : (d.v === 3 ? d.submitted : d.steps)
                ? ('proposed' as const)
                : d.v === 3 && d.edited
                  ? ('editing' as const)
                  : ('planning' as const)),
      }));
      const notes = Object.fromEntries(state.usage);
      if (JSON.stringify(notes) !== JSON.stringify(stats.notes))
        await atomic(join(this.directory(id), '.stats.json'), JSON.stringify({ v: 1, notes }));
      return { files, usage: state.usage, lastRun: state.lastRun, runs };
    });
  }

  async startPlan(id: string, group: string, mode: MaintenanceMode = 'review') {
    await this.locked(id, async () => {
      await this.validateWorkspace(id);
      await this.recover(id);
      const path = this.draftPath(id, group);
      if ((await readOptional(path)) !== null)
        throw new StashError('STASH_ALREADY_EXISTS', '整理编号重复');
      const base = await this.scan(id, true);
      const draft = await this.createStage(id, group, mode, base);
      await atomic(path, JSON.stringify(draft));
    });
  }

  /** 临时副本不创建待审记录；仍使用正式整理的并发检查和可恢复批次。 */
  async applyCompactionCopy(
    id: string,
    base: ReadonlyMap<string, string>,
    original: ReadonlyMap<string, string>,
    changes: PlanChange[],
    requireActive: () => void,
  ) {
    if (!changes.length) return;
    await this.locked(id, async () => {
      await this.validateWorkspace(id);
      await this.recover(id);
      const files = await this.scan(id, true),
        aliases = await this.aliases(id);
      if (
        snapshotRevision(files) !== snapshotRevision(base) ||
        aliases.size !== original.size ||
        [...original].some(([p, to]) => aliases.get(p) !== to)
      )
        throw new StashError('STASH_STALE_READ', '正式记忆已变化');
      await this.batch(id, 'stash-maint-' + randomUUID(), 'maintenance', changes, requireActive);
    });
  }

  private async trees(id: string, group: string) {
    const root = join(this.directory(id), '.staging', runId.parse(group));
    await this.safe(root, true);
    return new FileMemoryStore(root);
  }

  private async readTree(trees: FileMemoryStore, rev: string) {
    const files = new Map<string, string>();
    await trees.safe(trees.directory(rev));
    if (!(await lstat(trees.directory(rev))).isDirectory())
      throw new StashError('STASH_INVALID_DATA', '副本目录缺失');
    for (const path of await trees.list(rev))
      files.set(path, (await trees.read(rev, path))!.content);
    if (snapshotRevision(files) !== rev)
      throw new StashError('STASH_INVALID_DATA', '副本与版本不符');
    return files;
  }

  private async saveTree(
    trees: FileMemoryStore,
    files: Map<string, string>,
    previous?: { rev: string; files: Map<string, string> },
  ) {
    const rev = snapshotRevision(files),
      destination = trees.directory(rev);
    try {
      await lstat(destination);
      await this.readTree(trees, rev);
      return rev;
    } catch (error) {
      if (!missing(error)) throw error;
    }
    const temp = randomUUID(),
      dir = trees.directory(temp);
    await trees.safe(dir, true);
    try {
      for (const [path, content] of files) {
        if (previous?.files.get(path) === content) {
          const target = join(dir, memoryPath(path, true).slice(1));
          await trees.safe(dirname(target), true);
          try {
            await link(join(trees.directory(previous.rev), path.slice(1)), target);
          } catch (error) {
            // 不支持硬链接的文件系统仍可保存同样的独立副本。
            if (
              !['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'EPERM', 'EMLINK'].includes(
                (error as NodeJS.ErrnoException).code ?? '',
              )
            )
              throw error;
            await trees.replace(temp, path, content);
          }
        } else await trees.replace(temp, path, content);
      }
      await rename(dir, destination);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return rev;
  }

  private async createStage(
    id: string,
    group: string,
    mode: MaintenanceMode,
    files: Map<string, string>,
  ): Promise<StageDraft> {
    const trees = await this.trees(id, group);
    const base = await this.saveTree(trees, files);
    const baselineAliases = [...(await this.aliases(id))];
    return {
      v: 3,
      id: group,
      workspaceId: id,
      mode,
      base,
      working: base,
      generation: randomUUID(),
      edited: false,
      submitted: null,
      baselineAliases,
      redirects: baselineAliases,
    };
  }

  // 旧草稿按原快照重建；无法证明基线一致时不以当前文件覆盖旧内容。
  private async openStage(id: string, group: string) {
    const old = await this.draft(id, group);
    if (old.v === 3) return old;
    const files = await this.scan(id, true);
    if (snapshotRevision(files) !== old.base)
      throw new StashError('STASH_STALE_READ', '旧草稿已过期', { kind: 'maintenance-stale' });
    const stage = await this.createStage(id, group, old.mode, files);
    if (old.steps) {
      const aliases = new Map(stage.baselineAliases),
        preview = previewPlan(files, old.steps, aliases);
      for (const c of preview.changes) {
        if (c.after === null) files.delete(c.path);
        else files.set(c.path, c.after);
        if (c.redirect) aliases.set(c.path, c.redirect);
      }
      stage.working = await this.saveTree(await this.trees(id, group), files);
      stage.redirects = [...aliases];
      stage.submitted = digest(JSON.stringify([stage.base, preview]));
    }
    await atomic(this.draftPath(id, group), JSON.stringify(stage));
    return stage;
  }

  async stageSnapshot(id: string, group: string) {
    return this.locked(id, async () => {
      const d = await this.openStage(id, group);
      return {
        mode: d.mode,
        files: await this.readTree(await this.trees(id, group), d.working),
        generation: d.generation,
        redirects: new Map(d.redirects),
        base: d.base,
      };
    });
  }

  async stageDiff(id: string, group: string) {
    return this.locked(id, async () => {
      const d = await this.openStage(id, group),
        trees = await this.trees(id, group);
      const base = await this.readTree(trees, d.base),
        working = await this.readTree(trees, d.working);
      const aliases = new Map(d.redirects);
      const changes = fileChanges(base, working).map((c) => ({
        ...c,
        redirect: aliases.has(c.path) ? resolveRedirect(c.path, aliases) : null,
      }));
      return { changes, generation: d.generation };
    });
  }

  async editStage(
    id: string,
    group: string,
    edit: StageEdit,
    expected: string,
    requireActive: () => void,
  ) {
    return this.locked(id, async () => {
      await this.recover(id);
      requireActive();
      if (ledger((await this.loadJournal(id)).changes).groups.has(group))
        throw new StashError('STASH_READ_ONLY', '整理已结束', { kind: 'maintenance-closed' });
      const d = await this.openStage(id, group);
      if (d.generation !== expected)
        throw new StashError('STASH_STALE_READ', '请重新读取副本', { kind: 'maintenance-read' });
      const trees = await this.trees(id, group),
        previous = await this.readTree(trees, d.working);
      const files = edit.kind === 'reset' ? await this.readTree(trees, d.base) : new Map(previous);
      const aliases = new Map(edit.kind === 'reset' ? d.baselineAliases : d.redirects);
      if (edit.kind !== 'reset') editStage(files, aliases, edit);
      const working = await this.saveTree(trees, files, { rev: d.working, files: previous });
      if (working === d.working && JSON.stringify([...aliases]) === JSON.stringify(d.redirects))
        return d.generation;
      const gen = randomUUID();
      requireActive();
      await atomic(
        this.draftPath(id, group),
        JSON.stringify({
          ...d,
          working,
          generation: gen,
          redirects: [...aliases],
          edited: true,
          submitted: null,
        }),
      );
      if (d.working !== d.base && d.working !== working)
        await rm(trees.directory(d.working), { recursive: true, force: true });
      return gen;
    });
  }

  async plan(
    id: string,
    group: string,
    action:
      | { kind: 'submit'; generation: string }
      | { kind: 'review' }
      | { kind: 'apply'; revision: string; confirmed: number[] },
    validate: (files: ReadonlyMap<string, string>) => void,
    requireActive?: () => void,
  ) {
    return this.locked(id, async () => {
      await this.validateWorkspace(id);
      await this.recover(id);
      requireActive?.();
      const journal = await this.loadJournal(id);
      if (ledger(journal.changes).groups.has(group))
        throw new StashError('STASH_STALE_READ', '整理已经执行', { kind: 'maintenance-closed' });
      const d = await this.openStage(id, group);
      if (action.kind !== 'submit' && (!d.submitted || d.working === d.base))
        throw new StashError('STASH_STALE_READ', '没有可审阅的固定版本', {
          kind: 'maintenance-stale',
        });
      const auto = action.kind === 'submit' && d.mode === 'auto';
      if (action.kind === 'submit' && action.generation !== d.generation)
        throw new StashError('STASH_STALE_READ', '副本在查看差异后发生了变化', {
          kind: 'maintenance-diff',
        });
      const trees = await this.trees(id, group),
        files = await this.readTree(trees, d.working);
      const live = await this.scan(id, false),
        baseline = new Map(d.baselineAliases),
        aliases = new Map(d.redirects);
      const currentAliases = await this.aliases(id);
      if (
        snapshotRevision(live) !== d.base ||
        currentAliases.size !== baseline.size ||
        [...baseline].some(([p, t]) => currentAliases.get(p) !== t)
      )
        throw new StashError('STASH_STALE_READ', '正式记忆已变化，副本已保留', {
          kind: 'maintenance-stale',
        });
      const preview = stagePreview(live, files, baseline, aliases);
      validate(files);
      const revision = d.submitted ?? digest(JSON.stringify([d.base, d.generation, preview]));
      const applied = !!preview.changes.length && (auto || action.kind === 'apply');
      if (action.kind === 'apply') {
        if (action.revision !== revision)
          throw new StashError('STASH_STALE_READ', '审阅版本已变化', { kind: 'maintenance-stale' });
        if (
          action.confirmed.length !== preview.rules.length ||
          !preview.rules.every((r) => action.confirmed.includes(r.line))
        )
          throw new StashError('STASH_READ_ONLY', '需要确认全部规则');
      }
      requireActive?.();
      if (applied) await this.batch(id, group, 'maintenance', preview.changes, requireActive);
      else if (action.kind === 'submit' && revision !== d.submitted)
        await atomic(this.draftPath(id, group), JSON.stringify({ ...d, submitted: revision }));
      return { id: group, revision, ...preview, applied };
    });
  }

  async rollback(
    id: string,
    group: string,
    validate: (files: ReadonlyMap<string, string>) => void,
  ) {
    await this.locked(id, async () => {
      runId.parse(group);
      await this.validateWorkspace(id);
      await this.recover(id);
      for (const p of await this.list(id)) await this.read(id, p);
      const files = await this.scan(id, true);
      const journal = await this.loadJournal(id);
      if (ledger(journal.changes).groups.get(group) !== 'applied')
        throw new StashError('STASH_NOT_FOUND', '没有可回滚的整理组');
      const currentAliases = ledger(journal.changes).aliases;
      const entries = journal.changes.filter((c) => c.group === group);
      const changes: PlanPreview['changes'] = [];
      for (const c of entries) {
        if (
          journal.changes.findLast((x) => x.path.toLowerCase() === c.path.toLowerCase())?.id !==
          c.id
        )
          throw new StashError('STASH_STALE_READ', '整理后文件已被修改');
        changes.push({
          path: c.path,
          before: c.after?.content ?? null,
          after: c.before?.content ?? null,
          redirect: c.redirect ?? null,
        });
        if (c.before) files.set(c.path, c.before.content);
        else files.delete(c.path);
      }
      for (const c of entries) if (c.redirect) currentAliases.delete(c.path);
      for (const [from, to] of currentAliases)
        if (files.has(from) || !files.has(resolveRedirect(to, currentAliases)))
          throw new StashError('STASH_STALE_READ', '后续整理依赖此组');
      validate(files);
      await this.batch(id, group, 'rollback', changes);
    });
  }

  private async batch(
    id: string,
    group: string,
    op: string,
    rows: PlanChange[],
    requireActive?: () => void,
  ) {
    // 预检所有真实路径，包括 Markdown 清单之外的普通文件和空目录。
    for (const c of rows)
      if (((await this.read(id, c.path))?.content ?? null) !== c.before)
        throw new StashError('STASH_STALE_READ', '文件已变化');
    const changes: JournalChange[] = rows.map((c) => ({
      v: 1,
      id: randomUUID(),
      workspaceId: id,
      path: c.path,
      before: c.before === null ? null : memoryFile(c.before),
      after: c.after === null ? null : memoryFile(c.after),
      timestamp: new Date().toISOString(),
      actor: group,
      callId: group,
      op,
      group,
      ...(c.redirect ? { redirect: c.redirect } : {}),
    }));
    const journal = await this.loadJournal(id);
    if (
      journal.size + changes.reduce((n, c) => n + Buffer.byteLength(JSON.stringify(c)) + 1, 1) >
      32 * 1024 * 1024
    )
      throw new StashError('STASH_INVALID_DATA', '修改日志容量不足');
    requireActive?.();
    await atomic(join(this.directory(id), '.batch.json'), JSON.stringify({ v: 1, changes }));
    await this.recover(id);
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

  /** 整体清空持有工作区锁；每个删除沿用可恢复日志，不删除历史与设置。 */
  async clear(id: string, expected: string): Promise<void> {
    await this.locked(id, async () => {
      await this.validateWorkspace(id);
      await this.recover(id);
      for (const path of await this.list(id)) await this.read(id, path);
      const files = await this.scan(id, true);
      if (snapshotRevision(files) !== expected)
        throw new StashError('STASH_STALE_READ', '记忆已变化，请刷新后重新确认');
      const changes = [...files].map(([path, content]): JournalChange => ({
        v: 1,
        id: randomUUID(),
        workspaceId: id,
        path,
        before: memoryFile(content),
        after: null,
        timestamp: new Date().toISOString(),
        actor: 'ui',
        callId: 'clear',
        op: 'delete',
      }));
      const journal = await this.loadJournal(id);
      if (
        (journal.size ?? 0) +
          changes.reduce(
            (size, change) => size + Buffer.byteLength(JSON.stringify(change)) + 1,
            0,
          ) >
        32 * 1024 * 1024
      )
        throw new StashError('STASH_INVALID_DATA', '修改日志容量不足');
      for (const change of changes) {
        const pending = join(this.directory(id), '.pending.json');
        await atomic(pending, JSON.stringify(change));
        await this.replace(id, change.path, null);
        await this.append(id, change);
        await unlink(pending);
      }
    });
  }
}
