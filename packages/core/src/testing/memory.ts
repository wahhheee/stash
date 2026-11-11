import { StashError } from '../errors.ts';
import type {
  Clock,
  IdGen,
  TokenEstimator,
  SessionLogPort,
  SurfacePort,
  WorkspacePort,
  Workspace,
  MemoryStore,
  MemoryFile,
  MemoryChange,
  CommitCarrier,
  MemoryCommit,
  HistorySearch,
  SearchRequest,
  SearchResult,
  SwitchStore,
  SwitchScope,
  SwitchRecord,
  TraceSink,
  LogEvent,
  EventWindow,
} from '../ports/index.ts';
import type { TraceEvent } from '../trace/index.ts';

export class FixedClock implements Clock {
  constructor(private readonly instant = '2026-01-01T00:00:00.000Z') {}
  now(): Date {
    return new Date(this.instant);
  }
}
export class SequenceIds implements IdGen {
  private value = 0;
  next(): string {
    return String(++this.value);
  }
}
/** 测试估算器不宣称与任何模型分词器一致。 */
export class CharacterEstimator implements TokenEstimator {
  estimate(text: string): number {
    return [...text].length;
  }
}
export class MemorySessionLog implements SessionLogPort, SurfacePort {
  private readonly events = new Map<string, LogEvent[]>();
  private readonly hidden = new Map<string, Set<number>>();
  async read(id: string, window?: EventWindow): Promise<readonly LogEvent[]> {
    if (!this.events.has(id)) throw new StashError('STASH_NOT_FOUND', 'Session not found');
    return structuredClone(
      this.events.get(id)!.filter((e) => !window || (e.seq >= window.from && e.seq <= window.to)),
    );
  }
  seed(id: string, events: readonly LogEvent[]): void {
    this.events.set(id, structuredClone([...events]));
  }
  hide(id: string, seqs: readonly number[]): void {
    this.hidden.set(id, new Set(seqs));
  }
  async visible(id: string): Promise<readonly LogEvent[]> {
    return (await this.read(id)).filter((e) => !this.hidden.get(id)?.has(e.seq));
  }
  async append(id: string, message: Omit<LogEvent, 'sessionId' | 'seq'>): Promise<void> {
    const events = this.events.get(id);
    if (!events) throw new StashError('STASH_NOT_FOUND', 'Session not found');
    events.push(
      structuredClone({ ...message, sessionId: id, seq: (events.at(-1)?.seq ?? -1) + 1 }),
    );
  }
}
export class MemoryWorkspaces implements WorkspacePort {
  private readonly workspaces: readonly Workspace[];
  constructor(workspaces: readonly Workspace[] = []) {
    this.workspaces = structuredClone(workspaces);
  }
  async get(id: string): Promise<Workspace | null> {
    return structuredClone(this.workspaces.find((w) => w.id === id) ?? null);
  }
  async forSession(id: string): Promise<Workspace | null> {
    return structuredClone(this.workspaces.find((w) => w.sessionIds.includes(id)) ?? null);
  }
}
export class MemoryFiles implements MemoryStore {
  private readonly files = new Map<string, MemoryFile>();
  private readonly changes: MemoryChange[] = [];
  constructor(private readonly ids: IdGen = new SequenceIds()) {}
  private key(workspace: string, path: string): string {
    return JSON.stringify([workspace, path]);
  }
  async read(workspace: string, path: string): Promise<MemoryFile | null> {
    return structuredClone(this.files.get(this.key(workspace, path)) ?? null);
  }
  async list(workspace: string): Promise<readonly string[]> {
    return [...this.files.keys()]
      .map((k) => JSON.parse(k) as [string, string])
      .filter(([w]) => w === workspace)
      .map(([, p]) => p)
      .sort();
  }
  async write(
    workspaceId: string,
    path: string,
    content: string | null,
    expectedRevision: string | null,
  ): Promise<MemoryChange> {
    // 比较与更新之间不 await，模拟持锁的原子提交。
    const key = this.key(workspaceId, path);
    const before = this.files.get(key) ?? null;
    if ((before?.revision ?? null) !== expectedRevision)
      throw new StashError('STASH_STALE_READ', 'Read the file again before writing');
    const id = this.ids.next();
    const after = content === null ? null : { content, revision: id };
    if (after) this.files.set(key, after);
    else this.files.delete(key);
    const change: MemoryChange = { v: 1, id, workspaceId, path, before, after };
    this.changes.push(change);
    return structuredClone(change);
  }
  async journal(workspaceId: string): Promise<readonly MemoryChange[]> {
    return structuredClone(this.changes.filter((c) => c.workspaceId === workspaceId));
  }
}
export class MemoryCommits implements CommitCarrier {
  private readonly commits: MemoryCommit[] = [];
  async append(commit: MemoryCommit): Promise<void> {
    this.commits.push(structuredClone(commit));
  }
  async read(sessionId: string): Promise<readonly MemoryCommit[]> {
    return structuredClone(this.commits.filter((c) => c.sessionId === sessionId));
  }
}
export class MemorySearch implements HistorySearch {
  constructor(private readonly logs: SessionLogPort) {}
  async search(request: SearchRequest): Promise<SearchResult> {
    if (
      !request.sessionIds.length ||
      !request.query.trim() ||
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1
    )
      throw new StashError('STASH_INVALID_DATA', 'A bounded search is required');
    const normalize = (text: string): string => text.toLowerCase().replace(/\s+/gu, ' ');
    const since = request.since === undefined ? -Infinity : Date.parse(request.since);
    const until = request.until === undefined ? Infinity : Date.parse(request.until);
    if (Number.isNaN(since) || Number.isNaN(until) || since > until)
      throw new StashError('STASH_INVALID_DATA', 'Invalid time window');
    const hits: LogEvent[] = [];
    const ids = [...new Set(request.sessionIds)];
    for (const id of ids)
      for (const event of await this.logs.read(id)) {
        const timestamp = Date.parse(event.timestamp);
        if (!Number.isFinite(timestamp))
          throw new StashError('STASH_INVALID_DATA', 'Invalid event timestamp');
        if (timestamp < since || timestamp > until) continue;
        if (normalize(event.text).includes(normalize(request.query))) hits.push(event);
      }
    hits.sort(
      (a, b) =>
        Date.parse(a.timestamp) - Date.parse(b.timestamp) ||
        a.sessionId.localeCompare(b.sessionId) ||
        a.seq - b.seq,
    );
    return {
      hits: hits.slice(0, request.limit),
      scannedSessions: ids.length,
      truncated: hits.length > request.limit,
    };
  }
}
export class MemorySwitches implements SwitchStore {
  private readonly records = new Map<string, SwitchRecord>();
  private key(scope: SwitchScope): string {
    return scope.kind === 'global' ? 'global' : JSON.stringify([scope.kind, scope.id]);
  }
  async get(scope: SwitchScope): Promise<SwitchRecord | null> {
    return structuredClone(this.records.get(this.key(scope)) ?? null);
  }
  async set(scope: SwitchScope, value: SwitchRecord): Promise<void> {
    this.records.set(this.key(scope), structuredClone(value));
  }
}
export class MemoryTrace implements TraceSink {
  readonly events: TraceEvent[] = [];
  async emit(event: TraceEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
  async flush(): Promise<void> {}
}
