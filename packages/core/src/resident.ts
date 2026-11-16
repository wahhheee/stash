import type { TokenEstimator } from './ports/index.ts';
import { parseNote } from './notes.ts';
import { expandRules } from './rules.ts';
import {
  directoryEntry,
  indexEntry,
  typeEntry,
  omittedEntry,
  fullContext,
  rulesDelta,
  sessionRulesDelta,
  positionNotice,
} from './templates/index.ts';

export interface ResidentState {
  rules: string;
  index: string;
  folded: boolean;
  session?:
    | {
        id: string;
        rules: string;
        index: string;
        folded: boolean;
        parentRules?: string | undefined;
        readOnly?: boolean | undefined;
      }
    | undefined;
}

export interface ResidentRecord {
  v: 1;
  workspaceId: string;
  kind: 'full' | 'rules' | 'write' | 'position';
  state: ResidentState;
  /** 仅写入记录使用；旧记录未提供时沿用原有确认语义。 */
  trusted?: boolean | undefined;
  scope?: 'workspace' | 'session' | undefined;
}

export interface MemoryBudgets {
  rulesBudgetTokens: number;
  indexBudgetTokens: number;
  viewBudgetTokens: number;
  externalRuleUpdates: 'next-request' | 'next-compaction';
}

export function renderIndex(
  files: ReadonlyMap<string, string>,
  meter: TokenEstimator,
  budget: number,
  prefix = '',
): { index: string; folded: boolean } {
  const notes = [...files]
    .filter(([p]) => p.startsWith('/notes/'))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, text]) => ({ path, ...parseNote(text) }))
    .filter((n) => n.fields.index !== false && n.fields.status !== 'archived');
  let rows = notes.map((n) => ({
    path: n.path,
    text: indexEntry(prefix + n.path, String(n.fields.description), String(n.fields.type)),
  }));
  const fits = () => meter.estimate(rows.map((r) => r.text).join('\n')) <= budget;
  if (fits()) return { index: rows.map((r) => r.text).join('\n'), folded: false };
  const groups = new Map<string, typeof notes>();
  for (const note of notes) {
    const dir = note.path.slice(0, note.path.lastIndexOf('/') + 1);
    if (dir !== '/notes/') groups.set(dir, [...(groups.get(dir) ?? []), note]);
  }
  for (const [path, group] of [...groups].sort(
    ([a, aa], [b, bb]) => bb.length - aa.length || (a < b ? -1 : 1),
  )) {
    rows = rows.filter((r) => !group.some((n) => n.path === r.path));
    rows.push({
      path,
      text: directoryEntry(
        prefix + path,
        group.length,
        String(group.find((n) => n.path === path + 'README.md')?.fields.description ?? ''),
      ),
    });
    if (fits()) return { index: rows.map((r) => r.text).join('\n'), folded: true };
  }
  const root = notes.filter((n) => n.path.slice(0, n.path.lastIndexOf('/') + 1) === '/notes/');
  const counts = new Map<string, number>();
  for (const n of root)
    counts.set(String(n.fields.type), (counts.get(String(n.fields.type)) ?? 0) + 1);
  rows = rows.filter((r) => !root.some((n) => n.path === r.path));
  if (root.length)
    rows.push({
      path: '/notes/*.md',
      text: typeEntry([...counts].map(([type, count]) => count + ' ' + type).join(', '), prefix),
    });
  if (fits()) return { index: rows.map((r) => r.text).join('\n'), folded: true };
  let omitted = 0;
  while (
    rows.length &&
    meter.estimate([...rows.map((r) => r.text), omittedEntry(omitted, prefix)].join('\n')) > budget
  ) {
    rows.pop();
    omitted++;
  }
  return {
    index: [...rows.map((r) => r.text), omittedEntry(omitted, prefix)].join('\n'),
    folded: true,
  };
}

export function composeResident(
  files: ReadonlyMap<string, string>,
  meter: TokenEstimator,
  budget: number,
  prefix = '',
): ResidentState {
  return { rules: expandRules(files), ...renderIndex(files, meter, budget, prefix) };
}

export function foldResident(
  records: readonly ResidentRecord[],
  workspaceId: string,
): ResidentState | null {
  let state: ResidentState | null = null;
  for (const record of records) {
    if (record.v !== 1 || record.workspaceId !== workspaceId) continue;
    if (record.kind === 'write' && record.trusted === false) continue;
    if (record.kind === 'full') state = record.state;
    else if (state) {
      const previous: ResidentState = state;
      if (record.kind === 'position') {
        if (previous.session && record.state.session)
          state = {
            rules: previous.rules,
            index: previous.index,
            folded: previous.folded,
            session: { ...previous.session, id: record.state.session.id },
          };
      } else {
        state = {
          rules: record.scope === 'session' ? previous.rules : record.state.rules,
          index: previous.index,
          folded: previous.folded,
        };
        const session = record.scope === 'workspace' ? previous.session : record.state.session;
        if (session)
          state.session = {
            ...(record.kind === 'write' && previous.session ? previous.session : session),
            rules: session.rules,
            index: previous.session?.index ?? '',
            folded: previous.session?.folded ?? false,
          };
      }
    }
  }
  return state;
}

export function decideResident(
  believed: ResidentState | null,
  actual: ResidentState,
  workspace: string,
  meter: TokenEstimator,
  config: MemoryBudgets,
  compacted?: string,
): { kind: 'full' | 'rules' | 'none' | 'position'; reason: string; text: string } {
  const full = () => renderResident(workspace, actual, compacted);
  if (believed && actual.session && !believed.session)
    return { kind: 'full', reason: 'missing-session-snapshot', text: full() };
  if (!believed)
    return {
      kind: 'full',
      reason: 'missing-snapshot',
      text: full(),
    };
  if (believed.session?.readOnly !== actual.session?.readOnly)
    return { kind: 'full', reason: 'write-policy-changed', text: full() };
  if ((believed.session?.parentRules ?? '') !== (actual.session?.parentRules ?? ''))
    return { kind: 'full', reason: 'parent-rules-changed', text: full() };
  const sessionChanged = (believed.session?.rules ?? '') !== (actual.session?.rules ?? '');
  const moved = actual.session && believed.session?.id !== actual.session.id;
  if (believed.rules === actual.rules && !sessionChanged) {
    if (moved)
      return {
        kind: 'position',
        reason: 'session-changed',
        text: positionNotice(actual.session!.id),
      };
    return {
      kind: 'none',
      reason:
        believed.index === actual.index && believed.session?.index === actual.session?.index
          ? 'unchanged'
          : 'index-deferred',
      text: '',
    };
  }
  if (sessionChanged) {
    if (believed.rules !== actual.rules)
      return { kind: 'full', reason: 'layers-changed', text: full() };
    return {
      kind: 'rules',
      reason: 'session-rules-changed',
      text:
        (moved ? positionNotice(actual.session!.id) + '\n' : '') +
        sessionRulesDelta(believed.session?.rules ?? '', actual.session?.rules ?? ''),
    };
  }
  if (config.externalRuleUpdates === 'next-compaction') {
    if (moved)
      return {
        kind: 'position',
        reason: 'session-changed',
        text: positionNotice(actual.session!.id),
      };
    return { kind: 'none', reason: 'rules-deferred', text: '' };
  }
  const text = rulesDelta(believed.rules, actual.rules);
  if (meter.estimate(text) > config.rulesBudgetTokens / 2)
    return {
      kind: 'full',
      reason: 'large-change',
      text: full(),
    };
  return {
    kind: 'rules',
    reason: 'rules-changed',
    text: (moved ? positionNotice(actual.session!.id) + '\n' : '') + text,
  };
}

export function renderResident(
  workspace: string,
  state: ResidentState,
  compacted?: string,
): string {
  return fullContext(workspace, state.rules, state.index, state.folded, compacted, state.session);
}
