import type { Agent } from '@deepseek-ai/dsh-agent';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint';
import { decideResident, foldResident, type ResidentRecord } from '@wahhheee/stash-core';
import { isMaintenance } from './maintenance-schema.ts';
import { digest } from './revision.ts';
import { eventResident, residentSchema } from './memory-records.ts';
import type { MemoryAdapter } from './memory-dsh.ts';

export interface MemorySource {
  kind: 'stash-memory';
  form: 'instructions';
  stash: ResidentRecord;
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'stash-memory': MemorySource;
  }
}

export function visibleRecords(agent: Agent): ResidentRecord[] {
  const records: ResidentRecord[] = [];
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq);
    const record = eventResident(event);
    if (record) records.push(record);
  }
  return records;
}

export function compactionRange(agent: Agent): string | undefined {
  let first = Infinity;
  let last = -Infinity;
  for (const seq of agent.session.surface.nodes) {
    const event = agent.session.eventAt(seq);
    if (event?.type !== 'user/message' || !isCompactCheckpointSource(event.data.source)) continue;
    for (const source of event.sourceEventSeqs ?? []) {
      first = Math.min(first, source);
      last = Math.max(last, source);
    }
  }
  return first <= last ? `${first}..${last}` : undefined;
}

export function watchResident(adapter: MemoryAdapter) {
  const { ctx, config, trace } = adapter;
  const decisions = new WeakMap<Agent, string[]>();
  ctx.on('agent/pre-step', async ({ agent, step, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || (step === 1 && !decision.messages.length)) return decision;
    const policy = await adapter.policy(agent);
    await adapter.syncRegistration(agent, policy.enabled);
    // 整理工具自带副本上下文，不将正式记忆的规则或写权限提示混入编辑过程。
    if (isMaintenance(agent.id) || (!policy.enabled && !visibleRecords(agent).length))
      return decision;
    const memory = await adapter.memory(agent);
    const records = visibleRecords(agent);
    for (const message of decision.messages)
      if (message.source.kind === 'stash-memory')
        records.push(residentSchema.parse(message.source.stash));
    const session = await adapter.sessionMemory(agent);
    session.store.reset();
    const empty = { rules: '', index: '', folded: false };
    const workspace = policy.enabled && policy.inheritWorkspace ? await memory.actual() : empty;
    const actual = policy.enabled
      ? await adapter.actual(agent, workspace)
      : { ...empty, disabled: true };
    const believed = foldResident(records, memory.workspaceId);
    const compacted = compactionRange(agent);
    const result = decideResident(
      believed,
      actual,
      memory.workspaceId,
      adapter.meter,
      config,
      compacted,
    );
    const history = decisions.get(agent) ?? [];
    history.push(
      JSON.stringify({
        seq: agent.session.surface.nodes.at(-1),
        kind: result.kind,
        reason: result.reason,
        rulesHash: digest(actual.rules),
        indexHash: digest(actual.index),
      }),
    );
    decisions.set(agent, history.slice(-100));
    await trace.emit({
      v: 1,
      timestamp: new Date().toISOString(),
      kind: 'inject.decide',
      sessionId: agent.id,
      decision: result.kind === 'rules' || result.kind === 'position' ? 'delta' : result.kind,
      code: result.reason,
      hash: digest(actual.rules),
      tokens: adapter.meter.estimate(result.text),
    });
    signal.throwIfAborted();
    if (result.kind === 'none') return decision;
    const stash: ResidentRecord = {
      v: 1,
      workspaceId: memory.workspaceId,
      kind: result.kind,
      state:
        result.kind === 'position' && believed ? { ...believed, session: actual.session! } : actual,
    };
    return {
      ...decision,
      messages: [
        ...decision.messages,
        createUserMessage({
          content: [{ type: 'text', text: result.text }],
          source: { kind: 'stash-memory', form: 'instructions', stash },
        }),
      ],
    };
  });
  return (agent: Agent) => decisions.get(agent) ?? [];
}
