import { appendFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { traceMetadata } from '@wahhheee/stash-core';
import type { Clock, TraceEvent, TraceLevel, TraceSink } from '@wahhheee/stash-core';
import { redact } from './redaction.ts';

/** 单进程写入按调用顺序排队；失败对调用方和 flush 可见。 */
export class FileTraceSink implements TraceSink {
  private queue: Promise<void> = Promise.resolve();
  private failure: unknown;
  private prunedDay: string | undefined;

  constructor(
    private readonly root: string,
    private level: TraceLevel,
    private readonly retentionDays: number,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  getLevel(): TraceLevel {
    return this.level;
  }

  setLevel(level: TraceLevel): void {
    this.level = level;
  }

  emit(event: TraceEvent): Promise<void> {
    if (this.level === 'off') return Promise.resolve();
    const safe = traceMetadata(event);
    const body =
      this.level === 'content' && event.content !== undefined
        ? { ...safe, content: event.content }
        : safe;
    const line = redact(JSON.stringify(body)) + '\n';
    const day = this.clock.now().toISOString().slice(0, 10);
    const operation = this.queue.then(async () => {
      const directory = join(this.root, '.trace');
      await mkdir(directory, { recursive: true });
      await appendFile(join(directory, day + '.jsonl'), line, { encoding: 'utf8', mode: 0o600 });
      if (this.prunedDay === day) return;
      const cutoff = new Date(day + 'T00:00:00Z').getTime() - (this.retentionDays - 1) * 86400000;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(entry.name)) continue;
        if (Date.parse(entry.name.slice(0, 10) + 'T00:00:00Z') < cutoff) {
          try {
            await unlink(join(directory, entry.name));
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
      }
      this.prunedDay = day;
    });
    this.queue = operation.catch((error) => {
      this.failure = error;
    });
    return operation;
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.failure) throw this.failure;
  }
}
