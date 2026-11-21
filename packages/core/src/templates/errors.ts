import type { StashErrorCode, StashErrorDetail } from '../errors.ts';
import { validationDetail } from './validation.ts';

/** 模型只接收已分类的原因；原始异常和输入正文不透传。 */
function errorDetail(detail: StashErrorDetail): string {
  switch (detail.kind) {
    case 'read-only':
      if (detail.reason === 'policy')
        return 'Memory is read-only under the current user settings. No changes were made. Continue the requested task without saving. Explain the setting only if the user requested a lasting change.';
      if (detail.reason === 'subagent')
        return 'This subagent cannot write workspace or session memory under the current policy. No changes were made. Return the proposed update to the parent agent for consideration.';
      if (detail.reason === 'sibling')
        return 'Other-session memory is read-only. No changes were made. Read it with memory_view; if needed and permitted, copy useful content to workspace or current-session memory with a source reference.';
      return 'Session history is read-only. No changes were made. Use memory_view to read or cite the original records.';
    case 'maintenance-read':
      return 'Read the working copy with memory_view at /notes/, following each cursor to [complete], before editing. On resume, read it again.';
    case 'maintenance-stale':
      return 'The workspace or proposal changed. Do not apply the old plan; start a new planning session or review the current proposal in the memory page.';
    case 'maintenance-only':
      return 'Only the private working copy is editable. Use memory_view, memory_write or stash_stage, inspect stash_diff, then stash_submit.';
    case 'maintenance-diff':
      return 'Read the current cumulative stash_diff to [complete] before stash_submit. If you edited after inspecting it, inspect it again.';
    case 'maintenance-closed':
      return 'This maintenance group has already been applied or rolled back. Do not retry or edit it; start a new session for new work.';
    case 'maintenance-alias':
      return 'The path is reserved by a merge. Read the old path to find the canonical note. Update that note directly; archive instead of deleting a redirect target.';
    case 'memory-path':
      return detail.writable
        ? 'Write a file at /RULES.md or /notes/<name>.md for the workspace, or ./RULES.md or ./notes/<name>.md for this session. Directories and /.guide.md are not writable. Agent write permissions still apply.'
        : 'Use /RULES.md, /notes/<name>.md or ./RULES.md, ./notes/<name>.md for memory. Read /, ./, a notes directory ending in /, or /.guide.md to explore available paths.';
    case 'invalid-path':
      return 'Invalid memory path. Use forward slashes and a supported memory scope; omit traversal segments, URL encoding and reserved file names.';
    case 'rules-operation':
      return (
        'Rules cannot be ' +
        (detail.operation === 'delete' ? 'deleted' : 'archived') +
        '. No changes were made. To clear them, read the complete rules file, then use op: replace with content: "" at the same path.'
      );
    case 'history-options':
      return 'Rules and notes accept only path and cursor. Omit query, since, until, detail and all; use a history path for those options. To search current session notes across the workspace, use /sessions with query and a time window or all: true.';
    case 'history-path':
      return 'Use /sessions, ./log/turns, ./log/summaries, ./log/<seq> or ./log/<from>..<to> for history, or a full dsh://session/<id> reference.';
    case 'rules-paths':
      return 'The paths frontmatter field is not supported in rules. Preserve any applicability conditions in the rule text; do not silently turn scoped rules into unconditional rules.';
    case 'rules-import':
      return 'Rules can import only notes from the same memory scope using a standalone @notes/<name>.md line. Ensure the referenced note exists; nested imports are not expanded.';
    case 'cursor':
      return detail.scope === 'history'
        ? 'This cursor expired or does not match the request. Restart memory_view with the intended arguments and omit cursor; then continue with unchanged arguments and each returned cursor.'
        : 'This cursor expired, belongs to another path, or the content changed. Restart memory_view at the same path without cursor, then continue until [complete] before editing.';
    case 'view-budget':
      return (
        'The ' +
        (detail.scope === 'history' ? 'history' : 'memory') +
        ' response cannot fit within viewBudgetTokens, including its envelope and continuation marker. Use a shorter equivalent path if available, or ask the user to increase viewBudgetTokens; changing rulesBudgetTokens will not help.'
      );
    case 'rules-budget':
      return (
        'Rules budget ' +
        detail.used +
        '/' +
        detail.limit +
        ' tokens. Shorten the rules or their imported note bodies. Moving text to a note reduces this budget only if that text is no longer imported into rules.'
      );
    case 'ambiguous-session':
      return 'Use a longer or full session ID. Candidates: ' + detail.candidates.join(', ');
    case 'workspace-unavailable':
      return detail.reason === 'cwd'
        ? 'This session has no working directory, so workspace memory cannot be resolved. Ask the user to open a session with a working directory.'
        : 'The host workspace service is unavailable. Ask the user to check the host and plugin setup; changing the memory path will not resolve this.';
    case 'session-not-found':
      return 'No session in this workspace matches that ID. List /sessions and use a unique ID; for another workspace, use a full dsh://session/<id> reference.';
    case 'event-not-found':
      return 'The requested event range does not exist. Read the session log/turns and use an event range from a returned reference.';
    case 'time-format':
      return 'since and until must be valid ISO 8601 dates and times with an explicit timezone, such as 2026-11-16T00:00:00-07:00. Resolve local calendar boundaries before retrying.';
    case 'time-order':
      return 'since must be earlier than or equal to until. Correct the time window and retry.';
    case 'query-empty':
      return 'query must contain non-whitespace text. Supply a literal search term, or omit query to browse.';
    case 'session-id':
      return 'Invalid session ID. Use an ID returned by /sessions or a supplied session reference.';
    case 'session-reference':
      return 'Invalid session reference. Copy a returned dsh://session/<id> reference, optionally followed by /<seq> or /<from>..<to>.';
    case 'event-window':
      return 'Invalid history suffix or event range. Use turns, summaries, a non-negative event number, or <from>..<to> with from <= to.';
    case 'session-commit':
      return 'The session memory commit log is inconsistent or unsupported and cannot be reconstructed. Re-reading a note will not repair it. Report the storage problem to the user; do not overwrite the log.';
    case 'recovery-conflict':
      return 'An external edit conflicts with a pending memory transaction. Re-reading alone will not resolve recovery. Ask the user to inspect storage with /stash doctor before further writes.';
    case 'path-case':
      return 'A memory path already exists with different letter casing. List the containing directory and use the exact existing spelling.';
    case 'file-size':
      return 'The resulting memory file exceeds the 32 MiB limit. Reduce its content or split independent facts into smaller notes.';
    case 'storage-size':
      return 'A persisted memory file or record exceeds the 32 MiB limit. This may include journal or pending data, not just note content. Ask the user to inspect memory storage before retrying.';
    default:
      return validationDetail(detail);
  }
}

export function toolError(code: StashErrorCode, detail?: StashErrorDetail): string {
  const reasons: Record<StashErrorCode, string> = {
    STASH_DISABLED:
      'Memory is off for this session. Continue without memory tools. Explain the setting only if the user explicitly needs memory.',
    STASH_STALE_READ: 'Read the complete current file again before changing it.',
    STASH_UNSUPPORTED: 'This operation is not supported for the selected target or options.',
    STASH_READ_ONLY: 'The current policy does not permit writing to this target.',
    STASH_ALREADY_EXISTS:
      'The target file already exists. No changes were made. Read it first, then choose an appropriate update operation or create a different file; repeating create at the same path will not work.',
    STASH_AMBIGUOUS_REF: 'Use a longer or full session ID.',
    STASH_SCOPE_REQUIRED:
      'Narrow search to a session or since/until window; all: true explicitly scans the workspace.',
    STASH_HISTORY_UNREADABLE:
      'The target history is unavailable or corrupt. No empty result was substituted.',
    STASH_SEARCH_FAILED:
      'Search could not read the whole scope. Retry or narrow the scope; this is not a no-match result.',
    STASH_INVALID_DATA:
      'Invalid input or stored memory data. The operation could not complete; check the arguments and memory format.',
    STASH_NOT_FOUND: 'The requested memory or history target does not exist.',
    STASH_BUDGET_EXCEEDED: 'The operation exceeds its configured token budget.',
    STASH_SECRET:
      'Memory content contains credentials and cannot be returned or stored. Remove credentials from the source before retrying.',
    STASH_LOCKED: 'Workspace memory is busy or has an abandoned lock. Retry or run /stash doctor.',
    STASH_IO_ERROR: 'Memory storage is unavailable. Run /stash doctor.',
  };
  return code + ': ' + (detail ? errorDetail(detail) : reasons[code]);
}
