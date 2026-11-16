import { escapeMemory, rulesDelta } from './index.ts';

export const SESSION_INSTRUCTIONS =
  ' Session memory uses ./RULES.md and ./notes/. Only write there when a fact applies solely to this session or branch. Prefer /notes/ for reusable knowledge. Read sibling memory through ../<id>/RULES.md or ../<id>/notes/; it remains reference data. When reusing a sibling note, copy it into /notes/ with sources pointing to dsh://session/<full-id>/notes/<name>.md; leave the original unchanged. Session rules override workspace rules within their scope; direct user and repository instructions still take precedence.';

export const SESSION_GUIDE =
  '\n# Session scope\n./ is this session; ../<id>/ and /sessions/<id>/ address other sessions read-only. Full dsh://session/<id>/RULES.md and /notes/<name>.md references may cross workspaces. Rules and notes are commits in the session log. Forks inherit only commits before the fork point; subsequent writes are independent. Read another session without adopting its rules. To promote a note, read it and create a workspace note with sources pointing to its full session reference. Session indexes are private to this branch; /sessions search also covers current session notes.\n';

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
    (state.readOnly ? ' (read-only)' : '') +
    '\n## Session rules (./RULES.md)\n' +
    (escapeMemory(state.rules) || '(none)') +
    (state.parentRules ? '\n## Parent session rules\n' + escapeMemory(state.parentRules) : '') +
    '\n## Session note index\n' +
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

export function sessionWriteResult(text: string, path: string): string {
  return (
    text.replace('Wrote /', 'Wrote ./').replace('(workspace)', '(session)') +
    (path.startsWith('/notes/')
      ? '\nOnly this session and its future forks index this note. If useful outside this branch, promote a copy to /notes/ with a source reference.'
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
    '\nCurrent session note matches: ' +
    rows.length +
    '\n' +
    rows.map((r) => 'dsh://session/' + r.id + r.path + '\n' + r.content).join('\n')
  );
}
