import type { TraceEvent } from '../trace/index.ts';
/** 领域边界只传递数据，不暴露宿主对象、磁盘路径或模型客户端。 */
export interface Clock {
  now(): Date;
}
export interface IdGen {
  next(): string;
}
export interface TokenEstimator {
  estimate(text: string): number;
}
export interface LogEvent {
  readonly sessionId: string;
  readonly seq: number;
  readonly timestamp: string;
  readonly kind: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
export interface EventWindow {
  readonly from: number;
  readonly to: number;
}
export interface SessionLogPort {
  read(sessionId: string, window?: EventWindow): Promise<readonly LogEvent[]>;
}
export interface SurfacePort {
  visible(sessionId: string): Promise<readonly LogEvent[]>;
  append(sessionId: string, message: Omit<LogEvent, 'sessionId' | 'seq'>): Promise<void>;
}
export interface Workspace {
  readonly id: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
}
export interface WorkspacePort {
  get(id: string): Promise<Workspace | null>;
  forSession(sessionId: string): Promise<Workspace | null>;
}
export interface MemoryFile {
  readonly content: string;
  readonly revision: string;
}
export interface MemoryChange {
  readonly v: 1;
  readonly id: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly before: MemoryFile | null;
  readonly after: MemoryFile | null;
}
export interface MemoryStore {
  read(workspaceId: string, path: string): Promise<MemoryFile | null>;
  list(workspaceId: string): Promise<readonly string[]>;
  /** 版本检查、写入与日志在同一临界区完成；null 仅匹配不存在的文件。 */
  write(
    workspaceId: string,
    path: string,
    content: string | null,
    expectedRevision: string | null,
  ): Promise<MemoryChange>;
  journal(workspaceId: string): Promise<readonly MemoryChange[]>;
}
export interface MemoryCommit {
  readonly v: 1;
  readonly id: string;
  readonly sessionId: string;
  readonly path: string;
  readonly content: string | null;
}
export interface CommitCarrier {
  append(commit: MemoryCommit): Promise<void>;
  read(sessionId: string): Promise<readonly MemoryCommit[]>;
}
export interface SearchRequest {
  readonly sessionIds: readonly string[];
  readonly query: string;
  readonly since?: string;
  readonly until?: string;
  readonly limit: number;
}
export interface SearchResult {
  readonly hits: readonly LogEvent[];
  readonly scannedSessions: number;
  readonly truncated: boolean;
}
export interface HistorySearch {
  search(request: SearchRequest): Promise<SearchResult>;
}
export type SwitchScope =
  { readonly kind: 'global' } | { readonly kind: 'workspace' | 'session'; readonly id: string };
export interface SwitchRecord {
  readonly v: 1;
  readonly enabled: boolean | null;
  readonly writable: boolean | null;
  readonly discoverable: boolean;
  readonly inheritWorkspace: boolean;
}
export interface SwitchStore {
  get(scope: SwitchScope): Promise<SwitchRecord | null>;
  set(scope: SwitchScope, value: SwitchRecord): Promise<void>;
}
export interface TraceSink {
  emit(event: TraceEvent): Promise<void>;
  flush(): Promise<void>;
}
