import {
  maintenanceCorpus,
  memoryPath,
  resolveRedirect,
  redirectNotice,
  stagePage,
  STAGE_REFERENCE,
  StashError,
  NO_CHANGES,
} from '@wahhheee/stash-core';
import type { TokenEstimator } from '@wahhheee/stash-core';
import { randomUUID } from 'node:crypto';
import type { FileMemoryStore } from '../adapters/memory-store.ts';
import type { StageEdit } from '../adapters/stage-files.ts';

/** 阅读凭据限于当前会话和副本代次；续读不能跨文件或跨修改复用。 */
export class StageSession {
  private seen: string | null = null;
  private checked: string | null = null;
  private cursors = new Map<string, { key: string; offset: number }>();

  constructor(
    private store: FileMemoryStore,
    private id: string,
    private group: string,
    private meter: TokenEstimator,
    private budget: number,
    private active: () => void,
  ) {}

  private page(key: string, text: string, cursor: string | undefined, complete: () => void) {
    const progress = cursor ? this.cursors.get(cursor) : null;
    if (cursor && progress?.key !== key)
      throw new StashError('STASH_STALE_READ', '续读已过期', { kind: 'cursor', scope: 'memory' });
    const offset = progress?.offset ?? 0;
    const token = randomUUID();
    if (this.meter.estimate(stagePage(text.slice(offset))) <= this.budget) {
      complete();
      return stagePage(text.slice(offset));
    }
    let lo = offset,
      hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.meter.estimate(stagePage(text.slice(offset, mid), token)) <= this.budget) lo = mid;
      else hi = mid - 1;
    }
    if (lo === offset)
      throw new StashError('STASH_BUDGET_EXCEEDED', '无法分页', {
        kind: 'view-budget',
        scope: 'memory',
      });
    this.cursors.set(token, { key, offset: lo });
    return stagePage(text.slice(offset, lo), token);
  }

  async view(path: string, cursor?: string) {
    this.active();
    memoryPath(path);
    const s = await this.store.stageSnapshot(this.id, this.group);
    let text: string;
    if (path === '/notes/') text = maintenanceCorpus(s.files, s.mode);
    else if (path === '/.guide.md') text = STAGE_REFERENCE;
    else if (path === '/' || path === '/notes' || path.endsWith('/'))
      text = [...s.files.keys()]
        .filter((p) => p.startsWith(path))
        .sort()
        .join('\n');
    else {
      const canonical = resolveRedirect(path, s.redirects),
        content = s.files.get(canonical);
      if (content === undefined) throw new StashError('STASH_NOT_FOUND', '文件不存在');
      text = (canonical === path ? '' : redirectNotice(path, canonical)) + content;
    }
    return this.page(s.generation + path, text, cursor, () => {
      if (path === '/notes/') this.seen = s.generation;
    });
  }

  async edit(edit: StageEdit) {
    if (!this.seen)
      throw new StashError('STASH_STALE_READ', '先读完副本', { kind: 'maintenance-read' });
    const gen = await this.store.editStage(this.id, this.group, edit, this.seen, this.active);
    if (this.seen !== gen) {
      this.checked = null;
      this.cursors.clear();
    }
    this.seen = gen;
  }

  async diff(cursor?: string) {
    this.active();
    const { changes, generation } = await this.store.stageDiff(this.id, this.group);
    return this.page(
      generation + ':diff',
      changes.length ? JSON.stringify(changes) : NO_CHANGES,
      cursor,
      () => {
        this.checked = generation;
      },
    );
  }

  async submit(validate: (files: ReadonlyMap<string, string>) => void) {
    if (!this.seen)
      throw new StashError('STASH_STALE_READ', '请先读取副本', { kind: 'maintenance-read' });
    if (!this.checked || this.checked !== this.seen)
      throw new StashError('STASH_STALE_READ', '请核对差异', { kind: 'maintenance-diff' });
    return this.store.plan(
      this.id,
      this.group,
      { kind: 'submit', generation: this.checked },
      validate,
      this.active,
    );
  }
}
