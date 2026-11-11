export type StashErrorCode =
  'STASH_STALE_READ' | 'STASH_UNSUPPORTED' | 'STASH_INVALID_DATA' | 'STASH_NOT_FOUND';

export class StashError extends Error {
  constructor(
    readonly code: StashErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StashError';
  }
}
