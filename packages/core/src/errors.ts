import type { WriteField, WriteOperation } from './write.ts';

export type StashValidationDetail =
  | { kind: 'write-object' | 'write-operation' | 'write-unknown-field' }
  | { kind: 'write-required' | 'write-string' | 'write-empty'; field: WriteField }
  | { kind: 'write-forbidden'; operation: WriteOperation; field: WriteField }
  | { kind: 'edit-match'; count: number }
  | { kind: 'note-yaml' | 'note-unclosed' | 'note-mapping' }
  | { kind: 'note-field'; field: 'type' | 'description' | 'index' | 'status' };

export type StashErrorDetail =
  | StashValidationDetail
  | { kind: 'read-only'; reason: 'subagent' | 'sibling' | 'history' | 'policy' }
  | { kind: 'memory-path'; writable: boolean }
  | { kind: 'rules-operation'; operation: 'archive' | 'delete' }
  | { kind: 'cursor'; scope: 'memory' | 'history' }
  | { kind: 'view-budget'; scope: 'memory' | 'history' }
  | { kind: 'rules-budget'; used: number; limit: number }
  | { kind: 'ambiguous-session'; candidates: readonly string[] }
  | { kind: 'workspace-unavailable'; reason: 'registry' | 'cwd' }
  | {
      kind:
        | 'maintenance-read'
        | 'maintenance-stale'
        | 'maintenance-only'
        | 'maintenance-alias'
        | 'history-options'
        | 'history-path'
        | 'invalid-path'
        | 'rules-paths'
        | 'rules-import'
        | 'session-not-found'
        | 'event-not-found'
        | 'time-format'
        | 'time-order'
        | 'query-empty'
        | 'session-id'
        | 'session-reference'
        | 'event-window'
        | 'session-commit'
        | 'recovery-conflict'
        | 'path-case'
        | 'storage-size'
        | 'file-size';
    };

export type StashErrorCode =
  | 'STASH_DISABLED'
  | 'STASH_STALE_READ'
  | 'STASH_UNSUPPORTED'
  | 'STASH_READ_ONLY'
  | 'STASH_ALREADY_EXISTS'
  | 'STASH_INVALID_DATA'
  | 'STASH_NOT_FOUND'
  | 'STASH_BUDGET_EXCEEDED'
  | 'STASH_SECRET'
  | 'STASH_LOCKED'
  | 'STASH_AMBIGUOUS_REF'
  | 'STASH_SCOPE_REQUIRED'
  | 'STASH_HISTORY_UNREADABLE'
  | 'STASH_SEARCH_FAILED'
  | 'STASH_IO_ERROR';

export class StashError extends Error {
  constructor(
    readonly code: StashErrorCode,
    message: string,
    readonly detail?: StashErrorDetail,
  ) {
    super(message);
    this.name = 'StashError';
  }
}
