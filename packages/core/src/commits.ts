import type { MemoryCommit, MemoryFile } from './ports/index.ts';
import { memoryPath } from './namespace.ts';
import { StashError } from './errors.ts';

export interface CommitState {
  files: Record<string, MemoryFile>;
  applied: Record<string, string>;
}

export const emptyCommits = (): CommitState => ({ files: {}, applied: {} });

/** 原始提交决定状态；裁剪副本和重复载体不能重复应用。 */
export function foldCommit(state: CommitState, commit: MemoryCommit): CommitState {
  if (commit.v !== 1)
    throw new StashError('STASH_INVALID_DATA', '未知会话提交版本', { kind: 'session-commit' });
  memoryPath(commit.path, true);
  const signature = JSON.stringify([
    commit.sessionId,
    commit.path,
    commit.beforeRevision,
    commit.revision,
  ]);
  const previous = Object.hasOwn(state.applied, commit.id) ? state.applied[commit.id] : undefined;
  if (previous !== undefined) {
    if (previous !== signature)
      throw new StashError('STASH_INVALID_DATA', '提交标识冲突', { kind: 'session-commit' });
    return state;
  }
  if ((state.files[commit.path]?.revision ?? null) !== commit.beforeRevision)
    throw new StashError('STASH_INVALID_DATA', '会话提交链不连续', { kind: 'session-commit' });
  if ((commit.content === null) !== (commit.revision === null))
    throw new StashError('STASH_INVALID_DATA', '会话提交内容不一致', { kind: 'session-commit' });
  const files = { ...state.files };
  if (commit.content === null) delete files[commit.path];
  else files[commit.path] = { content: commit.content, revision: commit.revision! };
  return { files, applied: { ...state.applied, [commit.id]: signature } };
}

export function commitFiles(state: CommitState): Map<string, string> {
  return new Map(Object.entries(state.files).map(([path, file]) => [path, file.content]));
}
