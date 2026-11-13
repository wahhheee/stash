export type StashErrorCode =
  | 'STASH_STALE_READ'
  | 'STASH_UNSUPPORTED'
  | 'STASH_INVALID_DATA'
  | 'STASH_NOT_FOUND'
  | 'STASH_BUDGET_EXCEEDED'
  | 'STASH_SECRET'
  | 'STASH_LOCKED'
  | 'STASH_IO_ERROR';

export class StashError extends Error {
  constructor(
    readonly code: StashErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StashError';
  }
}
