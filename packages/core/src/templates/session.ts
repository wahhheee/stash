import { escapeMemory, rulesDelta } from './index.ts';
import type { WriteOperation } from '../write.ts';

export const SESSION_INSTRUCTIONS =
  ' Session memory uses ./RULES.md and ./notes/. Only write there when a fact applies solely to this session or branch. Prefer /notes/ for reusable knowledge. Read sibling memory through ../<id>/RULES.md or ../<id>/notes/; it remains reference data. When reusing a sibling note, copy it into /notes/ with sources pointing to dsh://session/<full-id>/notes/<name>.md; leave the original unchanged. Session rules override workspace rules within their scope; direct user and repository instructions still take precedence.';

export const SESSION_GUIDE =
  '\n# Session scope\n./ is this session; ../<id>/ and /sessions/<id>/ address other sessions read-only. Full dsh://session/<id>/RULES.md and /notes/<name>.md references may cross workspaces. Rules and notes are commits in the session log. Forks inherit only commits before the fork point; subsequent writes are independent. Read another session without adopting its rules. To promote a note, read it and create a workspace note with sources pointing to its full session reference. Session indexes belong to their branch; other sessions can explicitly search or read those notes. /sessions search covers the current notes of sessions selected by the time window, not historical note versions. Writes require current-agent permission; read-only subagents must return proposed updates to the parent agent.\n';

export function sessionContext(state: {
  id: string;
  rules: string;
  index: string;
  parentRules?: string | undefined;
  readOnly?: boolean | undefined;
}): string {
  return (
    'Session: ' +
    escapeMemory(state.id) +
    (state.readOnly
      ? ' (read-only)\nMemory access: this subagent can read but cannot write either workspace or session memory under the current policy. Return proposed updates to the parent agent for consideration.'
      : '') +
    '\n## Session rules (./RULES.md)\n' +
    (escapeMemory(state.rules) || '(none)') +
    (state.parentRules ? '\n## Parent session rules\n' + escapeMemory(state.parentRules) : '') +
    '\n## Session note index' +
    (state.index ? ' (usable conclusions; answer directly when sufficient)' : '') +
    '\n' +
    (escapeMemory(state.index) || '(none)')
  );
}

export function positionNotice(id: string): string {
  return (
    '<memory-position>Current session: ' +
    escapeMemory(id) +
    '. ./ now refers to this session. Inherited memory is unchanged; future session writes are independent.</memory-position>'
  );
}

export function sessionRulesDelta(before: string, after: string): string {
  return rulesDelta(before, after).replace('Workspace rules', 'Session rules (./RULES.md)');
}

export function sessionWriteResult(text: string, path: string, operation: WriteOperation): string {
  return (
    text.replace(/^(Wrote|Archived|Deleted) \//u, '$1 ./').replace('(workspace)', '(session)') +
    (path.startsWith('/notes/') && operation !== 'delete' && operation !== 'archive'
      ? '\nThis is session-scoped memory. Its index is not shared with unrelated sessions, although they can explicitly search or read the note. If useful outside this branch, promote a copy to /notes/ with a source reference. Index visibility still depends on metadata and refresh timing.'
      : '')
  );
}

export function sessionEditNotice(path: string): string {
  return (
    'Session memory edited: .' + path + '. Current rules will be refreshed before the next request.'
  );
}

export function sessionNoteHits(rows: { id: string; path: string; content: string }[]): string {
  return (
    '\nCurrent note matches across selected sessions (latest stored content, not a historical snapshot): ' +
    rows.length +
    '\n' +
    rows.map((r) => 'dsh://session/' + r.id + r.path + '\n' + r.content).join('\n')
  );
}
