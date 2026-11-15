import type { WriteField, WriteOperation } from './write.ts';

export type StashErrorDetail =
  | { kind: 'write-object' | 'write-operation' | 'write-unknown-field' }
  | { kind: 'write-required' | 'write-string' | 'write-empty'; field: WriteField }
  | { kind: 'write-forbidden'; operation: WriteOperation; field: WriteField }
  | { kind: 'edit-match'; count: number }
  | { kind: 'note-yaml' | 'note-unclosed' | 'note-mapping' }
  | { kind: 'note-field'; field: 'type' | 'description' | 'index' | 'status' };

export type StashErrorCode =
  | 'STASH_STALE_READ'
  | 'STASH_UNSUPPORTED'
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
