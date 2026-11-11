export type TraceLevel = 'off' | 'metadata' | 'content';
export type TraceKind =
  | 'plugin.start'
  | 'plugin.stop'
  | 'diagnostic'
  | 'inject.decide'
  | 'inject.emit'
  | 'tool.view'
  | 'tool.write'
  | 'commit.fold'
  | 'external.detect'
  | 'switch.change'
  | 'lock.wait'
  | 'error';
/** metadata 仅允许白名单字段；任意正文只允许放在 content 中。 */
export interface TraceEvent {
  readonly v: 1;
  readonly timestamp: string;
  readonly kind: TraceKind;
  readonly callId?: string;
  readonly sessionId?: string;
  readonly seq?: number;
  readonly durationMs?: number;
  readonly tokens?: number;
  readonly hash?: string;
  readonly code?: string;
  readonly decision?: 'none' | 'full' | 'delta';
  readonly content?: string;
}
export function traceMetadata(event: TraceEvent): TraceEvent {
  return {
    v: event.v,
    timestamp: event.timestamp,
    kind: event.kind,
    ...(event.callId !== undefined ? { callId: event.callId } : {}),
    ...(event.sessionId !== undefined ? { sessionId: event.sessionId } : {}),
    ...(event.seq !== undefined ? { seq: event.seq } : {}),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    ...(event.tokens !== undefined ? { tokens: event.tokens } : {}),
    ...(event.hash !== undefined ? { hash: event.hash } : {}),
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.decision !== undefined ? { decision: event.decision } : {}),
  };
}
