import { randomUUID } from 'node:crypto';
import {
  StashError,
  historyTarget,
  resolveSessionId,
  timeWindow,
  literalText,
  deduplicateHistory,
  historyEnvelope,
  historySessions,
  historyTurns,
  historyEvents,
  historySummaries,
  historySearchResult,
  HISTORY_BUDGET_ERROR,
  LiteralHistorySearch,
} from '@wahhheee/stash-core';
import type {
  HistoryEvent,
  HistoryPort,
  HistorySession,
  HistoryVisibility,
  TokenEstimator,
} from '@wahhheee/stash-core';

export interface HistoryInput {
  path: string;
  cursor?: string | undefined;
  query?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  detail?: 'brief' | 'full' | undefined;
  all?: boolean | undefined;
}

/** 每个 agent 独享快照续读状态，避免当前会话新增工具结果导致翻页失效。 */
export class HistoryBrowser {
  private readonly pages = new Map<string, { signature: string; text: string; offset: number }>();

  constructor(
    private readonly port: HistoryPort,
    private readonly workspaceId: string,
    private readonly current: string,
    private readonly meter: TokenEstimator,
    private readonly budget: number,
    private readonly visibility: HistoryVisibility = { discoverable: () => true },
  ) {}

  async view(input: HistoryInput): Promise<string> {
    const { cursor, ...args } = input;
    const signature = JSON.stringify(args);
    const previous = cursor ? this.pages.get(cursor) : undefined;
    if (cursor && (!previous || previous.signature !== signature))
      throw new StashError('STASH_STALE_READ', '历史续读标识已失效或参数变化');
    const text = previous?.text ?? (await this.render(input));
    const offset = previous?.offset ?? 0;
    const next = randomUUID();
    let end = text.length;
    const fits = (n: number) =>
      this.meter.estimate(
        historyEnvelope(input.path, text.slice(offset, n), n < text.length ? next : undefined),
      ) <= this.budget;
    if (!fits(end)) {
      let lo = offset,
        hi = end;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid - 1;
      }
      end = lo;
      if (end < text.length && /[\uD800-\uDBFF]/u.test(text.charAt(end - 1))) end--;
      if (end === offset) throw new StashError('STASH_BUDGET_EXCEEDED', HISTORY_BUDGET_ERROR);
    }
    if (end < text.length) {
      this.pages.set(next, { signature, text, offset: end });
      if (cursor) this.pages.delete(cursor);
      while (this.pages.size > 8) this.pages.delete(this.pages.keys().next().value!);
    } else if (cursor) this.pages.delete(cursor);
    return historyEnvelope(
      input.path,
      text.slice(offset, end),
      end < text.length ? next : undefined,
    );
  }

  private async render(input: HistoryInput): Promise<string> {
    const target = historyTarget(input.path, this.current);
    if (!target) throw new StashError('STASH_UNSUPPORTED', '非历史路径');
    const range = timeWindow(input.since, input.until);
    const query = input.query === undefined ? undefined : literalText(input.query);
    if (query === '') throw new StashError('STASH_INVALID_DATA', '查询不能为空');
    if (query && target.view === 'sessions' && !input.since && !input.until && !input.all)
      throw new StashError('STASH_SCOPE_REQUIRED', '请先收窄搜索范围');
    const ids = target.explicit
      ? [target.id!]
      : [...new Set([...(await this.port.ids(this.workspaceId)), this.current])].filter((id) =>
          this.visibility.discoverable(id, this.current),
        );
    const selected = target.id
      ? [target.explicit ? target.id : resolveSessionId(target.id, ids)]
      : ids;
    const sessions: HistorySession[] = [];
    try {
      for (const id of selected) sessions.push(await this.port.session(id));
    } catch {
      throw new StashError(
        query ? 'STASH_SEARCH_FAILED' : 'STASH_HISTORY_UNREADABLE',
        '无法完整读取历史范围',
      );
    }
    if (
      target.window &&
      (!sessions[0]?.events.some((e) => e.seq === target.window!.from) ||
        !sessions[0]?.events.some((e) => e.seq === target.window!.to))
    )
      throw new StashError('STASH_NOT_FOUND', '事件范围不存在');
    const inRange = (time: string) =>
      Date.parse(time) >= range.from && Date.parse(time) <= range.to;
    const events = sessions
      .flatMap((s) => s.events)
      .filter((e) => {
        if (target.window && (e.seq < target.window.from || e.seq > target.window.to)) return false;
        if (target.view === 'summaries' && !e.summary) return false;
        return inRange(e.timestamp);
      });
    if (query) {
      const search = new LiteralHistorySearch<HistoryEvent>({
        read: async (id) => events.filter((e) => e.sessionId === id),
      });
      const result = await search.search({
        sessionIds: selected,
        query,
        limit: Number.MAX_SAFE_INTEGER,
      });
      return historySearchResult(
        deduplicateHistory(result.hits),
        result.scannedSessions,
        input.since,
        input.until,
        input.query,
      );
    }
    if (target.view === 'sessions')
      return historySessions(
        sessions.filter((s) => inRange(s.created) || s.events.some((e) => inRange(e.timestamp))),
        ids,
      );
    const session = sessions[0]!;
    if (target.view === 'turns')
      return historyTurns(
        session.id,
        session.turns.filter(
          (t) => Date.parse(t.start) <= range.to && Date.parse(t.end) >= range.from,
        ),
      );
    if (target.view === 'summaries') return historySummaries(events);
    if (!target.window) throw new StashError('STASH_NOT_FOUND', '事件范围不存在');
    if (target.window.from === target.window.to) {
      const turn = session.turns.find(
        (t) => t.from <= target.window!.from && t.to >= target.window!.to,
      );
      if (turn)
        return historyEvents(
          session.events.filter((e) => e.seq >= turn.from && e.seq <= turn.to),
          input.detail === 'full',
        );
    }
    return historyEvents(events, input.detail === 'full');
  }
}
