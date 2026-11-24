import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { SessionEvent, Session } from '@deepseek-ai/dsh-session';
import { appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session';
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  commitFiles,
  emptyCommits,
  foldCommit,
  resolveRedirect,
  notePath,
  StashError,
  sessionEditNotice,
} from '@wahhheee/stash-core';
import type { CommitState, MemoryCommit } from '@wahhheee/stash-core';
import type { MemoryBackend } from '../host/memory.ts';
import { digest } from './revision.ts';
import { containsSecret } from './redaction.ts';

const recordType = 'plugin:stash/compaction';
type SessionState = CommitState & { aliases?: Record<string, string> | undefined };

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:stash/compaction': { v: 1; commits: MemoryCommit[]; redirects: [string, string][] };
  }
}

const batchSchema = z
  .object({
    v: z.literal(1),
    commits: z.array(z.unknown()).min(1),
    redirects: z.array(z.tuple([z.string(), z.string()])),
  })
  .strict();

function batchOf(event: SessionEvent) {
  const record = pluginRecordOf(event);
  if (record?.type !== recordType) return;
  const batch = batchSchema.parse(record.data);
  return { ...batch, commits: batch.commits.map(validateCommit) };
}

function applyBatch(
  state: SessionState,
  commits: MemoryCommit[],
  redirects: [string, string][],
): SessionState {
  const next = commits.reduce(foldCommit, state);
  const aliases = new Map(Object.entries(state.aliases ?? {}));
  for (const [from, to] of redirects) aliases.set(notePath(from), notePath(to));
  for (const [from, to] of aliases)
    if (next.files[from] || !next.files[resolveRedirect(to, aliases)])
      throw new StashError('STASH_INVALID_DATA', '会话重定向无效');
  return { ...next, ...(aliases.size ? { aliases: Object.fromEntries(aliases) } : {}) };
}

export function appendCompactionBatch(
  session: Session,
  state: SessionState,
  commits: MemoryCommit[],
  redirects: [string, string][],
) {
  applyBatch(state, commits, redirects);
  appendPluginRecord(session, recordType, { v: 1, commits, redirects });
}

export const commitSchema = z
  .object({
    v: z.literal(1),
    id: z.string().uuid(),
    sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,256}$/u),
    path: z.string(),
    content: z.string().nullable(),
    beforeRevision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    revision: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
  })
  .strict();

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'stash-commit': { kind: 'stash-commit'; form: 'instructions'; commit: MemoryCommit };
  }
}

export function validateCommit(value: unknown): MemoryCommit {
  const commit = commitSchema.parse(value);
  if ((commit.content === null ? null : digest(commit.content)) !== commit.revision)
    throw new StashError('STASH_INVALID_DATA', '会话提交哈希错误', { kind: 'session-commit' });
  if (commit.content !== null && containsSecret(commit.content))
    throw new StashError('STASH_SECRET', '会话提交包含凭据');
  return commit;
}

/** 只接受成功结果和本插件的来源化通知，不读取模型可伪造的正文。 */
export function eventCommit(event: SessionEvent): MemoryCommit | null {
  if (event.type === 'user/message' && event.data.source.kind === 'stash-commit')
    return validateCommit(event.data.source.commit);
  if (
    event.type === 'tool/result' &&
    !event.data.message.isError &&
    event.data.meta &&
    typeof event.data.meta === 'object' &&
    'stashCommit' in event.data.meta
  )
    return validateCommit(event.data.meta.stashCommit);
  return null;
}

export function eventCommits(event: SessionEvent) {
  const batch = batchOf(event);
  if (batch) return batch.commits;
  const commit = eventCommit(event);
  return commit ? [commit] : [];
}

function applyEvent(state: SessionState, event: SessionEvent): SessionState {
  const batch = batchOf(event);
  if (batch) return applyBatch(state, batch.commits, batch.redirects);
  const commit = eventCommit(event);
  if (!commit) return state;
  const next = foldCommit(state, commit);
  if (!state.aliases) return next;
  const aliases = new Map(Object.entries(state.aliases));
  if (commit.content === null)
    for (const p of [...aliases.keys()].filter((p) => resolveRedirect(p, aliases) === commit.path))
      aliases.delete(p);
  return { ...next, aliases: Object.fromEntries(aliases) };
}

export function foldSession(events: readonly SessionEvent[]): SessionState {
  return events.reduce(applyEvent, emptyCommits());
}

export const sessionMemoryProjection: ProjectionDefinition<'stashSessionMemory', SessionState> = {
  key: 'stashSessionMemory',
  stateVersion: 2,
  stateSchema: z
    .object({
      files: z.record(z.string(), z.object({ content: z.string(), revision: z.string() }).strict()),
      applied: z.record(z.string(), z.string()),
      aliases: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  init: emptyCommits,
  apply: applyEvent,
};

/** 界面写入和嵌套调用共用通知载体；调用方负责将其追加或 deferContext。 */
export function commitMessage(commit: MemoryCommit, text = sessionEditNotice(commit.path)) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'stash-commit', form: 'instructions', commit: validateCommit(commit) },
  });
}

/** 未结算提交仅在同一次根工具调用内可见；请求边界清除，日志始终为正本。 */
export class SessionMemoryStore implements MemoryBackend {
  private pending: MemoryCommit[] = [];
  private root = '';
  private calls = new Map<string, string>();

  constructor(
    private readonly session: Session,
    private readonly stateOf: () => SessionState,
  ) {}

  begin(root: string) {
    if (root !== this.root) {
      this.reset();
      this.root = root;
    }
  }

  reset() {
    this.pending = [];
    this.calls.clear();
    this.root = '';
  }

  settle(callId: string, failed: boolean, root: boolean) {
    if (failed) this.pending = this.pending.filter((c) => c.id !== this.calls.get(callId));
    this.calls.delete(callId);
    if (root) this.reset();
  }

  lastCommit(): MemoryCommit {
    return this.pending.at(-1)!;
  }

  pendingCommits(): readonly MemoryCommit[] {
    return [...this.pending];
  }

  state(): CommitState {
    return this.pending.reduce(foldCommit, this.stateOf());
  }

  async snapshot() {
    return commitFiles(this.state());
  }

  async read(_id: string, path: string) {
    return this.state().files[path] ?? null;
  }

  async readNote(id: string, path: string) {
    const target = resolveRedirect(path, new Map(Object.entries(this.stateOf().aliases ?? {})));
    return { path: target, file: await this.read(id, target) };
  }

  async transact<T>(
    _id: string,
    path: string,
    expected: string | null | undefined,
    _actor: string,
    call: string,
    op: string,
    transform: (files: Map<string, string>) => { content: string | null; value: T },
  ): Promise<T> {
    const state = this.state();
    const aliases = new Map(Object.entries(this.stateOf().aliases ?? {}));
    if (
      [...aliases.keys()].some((p) => p.toLowerCase() === path.toLowerCase()) ||
      (op === 'delete' && [...aliases.values()].includes(path))
    )
      throw new StashError('STASH_READ_ONLY', '路径参与重定向', { kind: 'maintenance-alias' });
    const before = state.files[path]?.revision ?? null;
    if (expected === null && before !== null && op === 'create')
      throw new StashError('STASH_ALREADY_EXISTS', '会话文件已存在');
    if (expected !== undefined && before !== expected)
      throw new StashError('STASH_STALE_READ', '会话文件已变化');
    if (Object.keys(state.files).some((p) => p !== path && p.toLowerCase() === path.toLowerCase()))
      throw new StashError('STASH_INVALID_DATA', '路径大小写冲突', { kind: 'path-case' });
    const result = transform(commitFiles(state));
    if (result.content !== null && Buffer.byteLength(result.content) > 32 * 1024 * 1024)
      throw new StashError('STASH_INVALID_DATA', '会话文件超过 32 MiB', { kind: 'file-size' });
    const commit = validateCommit({
      v: 1,
      id: randomUUID(),
      sessionId: this.session.id,
      path,
      content: result.content,
      beforeRevision: before,
      revision: result.content === null ? null : digest(result.content),
    });
    foldCommit(state, commit);
    this.pending.push(commit);
    this.calls.set(call, commit.id);
    return result.value;
  }
}
