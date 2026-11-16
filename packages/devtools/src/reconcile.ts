import { foldSession } from '../../plugin/src/adapters/session-memory.ts';
import { commitFiles, expandRules } from '@wahhheee/stash-core';
import type {} from '@deepseek-ai/dsh-session-persistence';
import { Context } from '@deepseek-ai/cordis';
import * as Persistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { Session, SessionId } from '@deepseek-ai/dsh-session';

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { composeResident, foldResident, decideResident } from '@wahhheee/stash-core';
import type { ResidentRecord } from '@wahhheee/stash-core';
import { FileMemoryStore, digest } from '../../plugin/src/adapters/memory-store.ts';
import { eventResident, auditSchema } from '../../plugin/src/adapters/memory-records.ts';

export const offlineMeter = { estimate: (text: string) => Math.ceil(text.length / 4) };

/** 使用宿主只读句柄和 Session 的 surface 投影，避免自行解码会话格式。 */
export async function reconcile(
  memoryRoot: string,
  workspaceId: string,
  sessionRoot: string,
  sessionId: string,
): Promise<string[]> {
  if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error('无效会话 ID');
  const store = new FileMemoryStore(memoryRoot);
  const journal = await store.journal(workspaceId);
  const audits = (
    await readFile(join(store.directory(workspaceId), '.decisions-' + sessionId + '.jsonl'), 'utf8')
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => auditSchema.parse(JSON.parse(line)));
  const ctx = new Context();
  try {
    await ctx.plugin(Persistence, { root: sessionRoot });
    const handle = await ctx.sessionPersistence.open(SessionId(sessionId), 'read');
    try {
      const { events } = await handle.read();
      const lines: string[] = [];
      for (const [i, audit] of audits.entries()) {
        if (audit.sessionId !== sessionId || audit.beforeSeq > events.length)
          throw new Error('决策记录与会话不一致');
        const files = new Map<string, string>();
        const end =
          audit.journalId === null ? -1 : journal.findIndex((c) => c.id === audit.journalId);
        if (audit.journalId !== null && end < 0) throw new Error('决策引用的修改版本不存在');
        for (const change of journal.slice(0, end + 1)) {
          if (change.after) files.set(change.path, change.after.content);
          else files.delete(change.path);
        }
        const prefix = Session.create(
          handle.id,
          events.slice(0, audit.beforeSeq),
          handle.header,
          handle.inheritedEventCount,
        );
        const records: ResidentRecord[] = [];
        for (const seq of prefix.surface.nodes) {
          const event = prefix.eventAt(seq);
          const record = eventResident(event);
          if (record) records.push(record);
        }
        const actual = composeResident(files, offlineMeter, audit.config.indexBudgetTokens);
        if (audit.sessionMemory) {
          const state = composeResident(
            commitFiles(foldSession(prefix.snapshotEvents())),
            offlineMeter,
            audit.config.indexBudgetTokens,
            '.',
          );
          actual.session = {
            ...state,
            id: sessionId,
            readOnly: audit.readOnly ?? false,
          };
        }
        if (audit.parent && actual.session) {
          const parent = await ctx.sessionPersistence.open(SessionId(audit.parent.id), 'read');
          try {
            const { events: parentEvents } = await parent.read();
            if (audit.parent.beforeSeq > parentEvents.length) throw new Error('父会话记录不足');
            actual.session.parentRules = expandRules(
              commitFiles(foldSession(parentEvents.slice(0, audit.parent.beforeSeq))),
            );
          } finally {
            await parent.close();
          }
        }
        const expected = decideResident(
          foldResident(records, workspaceId),
          actual,
          workspaceId,
          offlineMeter,
          audit.config,
          audit.compacted ?? undefined,
        );
        if (
          expected.kind !== audit.kind ||
          expected.reason !== audit.reason ||
          digest(expected.text) !== audit.textHash
        )
          throw new Error('决策重放不一致：seq ' + audit.beforeSeq);
        const entered = events.slice(audit.beforeSeq, audits[i + 1]?.beforeSeq ?? events.length);
        const emitted = entered.filter(
          (e) =>
            e.type === 'user/message' &&
            e.data.source.kind === 'stash-memory' &&
            e.data.source.stash.kind !== 'write',
        );
        const requested = entered.some(
          (e) => e.type === 'assistant/message' || e.type === 'assistant/attempt',
        );
        if (
          requested &&
          (expected.kind === 'none'
            ? emitted.length !== 0
            : emitted.length !== 1 ||
              emitted.some(
                (e) =>
                  e.type === 'user/message' &&
                  digest(
                    e.data.content
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text)
                      .join(''),
                  ) !== audit.textHash,
              ))
        )
          throw new Error('实际注入与重放不一致：seq ' + audit.beforeSeq);
        lines.push(
          (requested ? 'OK ' : '未发出模型请求 ') +
            audit.beforeSeq +
            ' ' +
            audit.kind +
            ' ' +
            audit.reason,
        );
      }
      if (!audits.length) throw new Error('没有可重放的决策记录');
      return lines;
    } finally {
      await handle.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
}
