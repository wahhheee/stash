import { StashError } from './errors.ts';
import type {
  LogEvent,
  SessionLogPort,
  SearchRequest,
  SearchResult,
  HistorySearch,
} from './ports/index.ts';

export interface HistoryEvent extends LogEvent {
  readonly full: string;
  readonly human?: boolean;
  readonly turn?: number;
  readonly summary?: readonly number[];
  readonly inherited: boolean;
  readonly fingerprint: string;
}

export interface HistoryTurn {
  turn: number;
  from: number;
  to: number;
  start: string;
  end: string;
  prompt: string;
  response: string;
  complete: boolean;
}

export interface HistorySession {
  memory?: Record<string, string>;
  lineage?: { source: string | null; candidates: string[] };
  id: string;
  title: string;
  created: string;
  events: readonly HistoryEvent[];
  turns: readonly HistoryTurn[];
}

export interface HistoryPort extends SessionLogPort {
  session(id: string): Promise<HistorySession>;
  ids(workspaceId: string): Promise<readonly string[]>;
}

/** 显式引用绕过发现策略；发现策略不承担宿主权限认证。 */
export interface HistoryVisibility {
  discoverable(id: string, current: string): boolean;
}

export function timeWindow(since?: string, until?: string): { from: number; to: number } {
  const parse = (value: string | undefined, fallback: number) => {
    if (value === undefined) return fallback;
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
        value,
      ) ||
      !Number.isFinite(Date.parse(value))
    )
      throw new StashError('STASH_INVALID_DATA', '时间必须带时区', { kind: 'time-format' });
    const day = value.slice(0, 10);
    if (new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day)
      throw new StashError('STASH_INVALID_DATA', '无效日历日期', { kind: 'time-format' });
    return Date.parse(value);
  };
  const from = parse(since, -Infinity),
    to = parse(until, Infinity);
  if (from > to) throw new StashError('STASH_INVALID_DATA', '时间范围颠倒', { kind: 'time-order' });
  return { from, to };
}

export function literalText(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, ' ').trim();
}

export function preview(text: string, limit = 120): string {
  const value = text.replace(/\s+/gu, ' ').trim();
  return value.length > limit ? value.slice(0, limit - 1) + '…' : value;
}

export function foldHistoryTurn(
  turns: readonly HistoryTurn[],
  event: Pick<HistoryEvent, 'kind' | 'seq' | 'timestamp' | 'turn' | 'human' | 'text'>,
): readonly HistoryTurn[] {
  if (event.kind === 'turn/start' && event.turn !== undefined)
    return [
      ...turns,
      {
        turn: event.turn,
        from: event.seq,
        to: event.seq,
        start: event.timestamp,
        end: event.timestamp,
        prompt: '',
        response: '',
        complete: false,
      },
    ];
  const last = turns.at(-1);
  if (!last || last.complete) return turns;
  return [
    ...turns.slice(0, -1),
    {
      ...last,
      to: event.seq,
      end: event.timestamp,
      prompt: event.human && !last.prompt ? preview(event.text) : last.prompt,
      response:
        event.kind === 'assistant/message' && event.text ? preview(event.text, 240) : last.response,
      complete: event.kind === 'turn/end',
    },
  ];
}

export interface HistoryHit {
  event: HistoryEvent;
  alsoIn: string[];
}

/** 只有继承事件才能与相同原始事件合并，独立会话的相同文字仍保留。 */
export function deduplicateHistory(events: readonly HistoryEvent[]): HistoryHit[] {
  const groups = new Map<string, HistoryHit[]>();
  for (const event of [...events].sort(
    (a, b) =>
      Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
      Number(a.inherited) - Number(b.inherited) ||
      a.sessionId.localeCompare(b.sessionId) ||
      a.seq - b.seq,
  )) {
    const group = groups.get(event.fingerprint) ?? [];
    const match = event.inherited ? group[0] : undefined;
    if (match) match.alsoIn.push(event.sessionId);
    else group.push({ event, alsoIn: [] });
    groups.set(event.fingerprint, group);
  }
  return [...groups.values()]
    .flat()
    .sort(
      (a, b) =>
        Date.parse(a.event.timestamp) - Date.parse(b.event.timestamp) || a.event.seq - b.event.seq,
    );
}

export class LiteralHistorySearch<T extends LogEvent = LogEvent> implements HistorySearch {
  constructor(private readonly logs: { read(id: string): Promise<readonly T[]> }) {}

  async search(request: SearchRequest): Promise<SearchResult & { hits: readonly T[] }> {
    const range = timeWindow(request.since, request.until),
      query = literalText(request.query);
    if (!query || !Number.isSafeInteger(request.limit) || request.limit < 1)
      throw new StashError('STASH_INVALID_DATA', '无效搜索条件');
    const hits: T[] = [];
    for (const id of request.sessionIds)
      for (const event of await this.logs.read(id)) {
        const time = Date.parse(event.timestamp);
        if (time >= range.from && time <= range.to && literalText(event.text).includes(query))
          hits.push(event);
      }
    hits.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.seq - b.seq);
    return {
      hits: hits.slice(0, request.limit),
      scannedSessions: request.sessionIds.length,
      truncated: hits.length > request.limit,
    };
  }
}
