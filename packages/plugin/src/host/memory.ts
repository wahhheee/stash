import {
  StashError,
  memoryPath,
  composeResident,
  parseNote,
  archiveNote,
  GUIDE,
  viewResult,
  writeResult,
  budgetDetail,
  expandRules,
  frontmatter,
} from '@wahhheee/stash-core';
import type {
  TokenEstimator,
  MemoryBudgets,
  ResidentState,
  WriteInput,
} from '@wahhheee/stash-core';
import type { FileMemoryStore } from '../adapters/memory-store.ts';
import { digest } from '../adapters/memory-store.ts';
import { containsSecret } from '../adapters/redaction.ts';

export type MemoryBackend = Pick<FileMemoryStore, 'observe' | 'snapshot' | 'read' | 'transact'>;

/** 读取凭据只存在于当前 agent；完整连续读完才允许覆盖。 */
export class WorkspaceMemory {
  private readonly reads = new Map<string, string>();
  private readonly cursors = new Map<string, { path: string; revision: string; offset: number }>();

  constructor(
    readonly store: MemoryBackend,
    readonly workspaceId: string,
    readonly sessionId: string,
    readonly meter: TokenEstimator,
    readonly config: MemoryBudgets,
    readonly indexPrefix = '',
  ) {}

  async observe(): Promise<{ state: ResidentState; journalId: string | null }> {
    const observed = await this.store.observe(this.workspaceId);
    const state = composeResident(
      observed.files,
      this.meter,
      this.config.indexBudgetTokens,
      this.indexPrefix,
    );
    const used = this.meter.estimate(state.rules);
    if (used > this.config.rulesBudgetTokens)
      throw new StashError(
        'STASH_BUDGET_EXCEEDED',
        budgetDetail(used, this.config.rulesBudgetTokens),
        { kind: 'rules-budget', used, limit: this.config.rulesBudgetTokens },
      );
    return { state, journalId: observed.journalId };
  }

  async actual(): Promise<ResidentState> {
    return (await this.observe()).state;
  }

  async view(path: string, cursor?: string, displayPath = path): Promise<string> {
    memoryPath(path);
    let text: string;
    let file = false;
    if (path === '/.guide.md') text = GUIDE;
    else if (path === '/' || path === '/notes' || path.endsWith('/')) {
      const files = await this.store.snapshot(this.workspaceId);
      text = [...files]
        .filter(([p]) => path === '/' || p.startsWith(path === '/notes' ? '/notes/' : path))
        .map(
          ([p, content]) =>
            (displayPath.startsWith('./') ? '.' + p : p) +
            (p.startsWith('/notes/') ? ': ' + String(parseNote(content).fields.description) : ''),
        )
        .join('\n');
    } else {
      const value = await this.store.read(this.workspaceId, path);
      if (!value) throw new StashError('STASH_NOT_FOUND', '文件不存在');
      text = value.content;
      file = true;
    }
    if (containsSecret(text)) throw new StashError('STASH_SECRET', '文件包含凭据');
    const revision = digest(text);
    let offset = 0;
    if (cursor) {
      const progress = this.cursors.get(cursor);
      if (!progress || progress.path !== path || progress.revision !== revision)
        throw new StashError('STASH_STALE_READ', '续读标识已失效', {
          kind: 'cursor',
          scope: 'memory',
        });
      offset = progress.offset;
    } else this.reads.delete(path);
    let end = text.length;
    const fits = (n: number) =>
      this.meter.estimate(viewResult(displayPath, text.slice(offset, n), revision + ':' + n)) <=
      this.config.viewBudgetTokens;
    if (!fits(end)) {
      let low = offset,
        high = end;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(mid)) low = mid;
        else high = mid - 1;
      }
      end = low;
      if (end === offset)
        throw new StashError('STASH_BUDGET_EXCEEDED', '读取预算不足', {
          kind: 'view-budget',
          scope: 'memory',
        });
    }
    if (end < text.length) {
      const next = revision + ':' + end;
      this.cursors.set(next, { path, revision, offset: end });
      return viewResult(displayPath, text.slice(offset, end), next);
    }
    if (file) this.reads.set(path, revision);
    return viewResult(displayPath, text.slice(offset));
  }

  async write(
    input: WriteInput,
    callId: string,
    knownRules: string | null = null,
  ): Promise<{ text: string; state: ResidentState; trusted: boolean }> {
    const path = memoryPath(input.path, true);
    if (path === '/RULES.md' && (input.op === 'archive' || input.op === 'delete'))
      throw new StashError('STASH_UNSUPPORTED', '规则不支持此操作', {
        kind: 'rules-operation',
        operation: input.op,
      });
    const destructive = ['edit', 'replace', 'archive', 'delete'].includes(input.op);
    const expected = input.op === 'create' ? null : destructive ? this.reads.get(path) : undefined;
    if (destructive && expected === undefined)
      throw new StashError('STASH_STALE_READ', '需要先完整读取');
    return this.store.transact(
      this.workspaceId,
      path,
      expected,
      this.sessionId,
      callId,
      input.op,
      (files) => {
        const before = files.get(path);
        // 与会话可见版本比较，其他会话已记录的修改同样不能被顺带确认。
        let trusted = knownRules !== null && expandRules(files) === knownRules;
        let content: string | null;
        if (input.op !== 'create' && before === undefined)
          throw new StashError('STASH_NOT_FOUND', '文件不存在');
        switch (input.op) {
          case 'create':
          case 'replace':
            content = input.content;
            break;
          case 'append':
            content = before! + input.content;
            break;
          case 'edit': {
            if (!input.old)
              throw new StashError('STASH_INVALID_DATA', '旧文本不能为空', {
                kind: 'write-empty',
                field: 'old',
              });
            const count = before!.split(input.old).length - 1;
            if (count !== 1)
              throw new StashError('STASH_INVALID_DATA', '旧文本必须唯一', {
                kind: 'edit-match',
                count,
              });
            content = before!.replace(input.old, () => input.new);
            break;
          }
          case 'archive':
            content = archiveNote(before!);
            break;
          case 'delete':
            content = null;
            break;
        }
        if (content !== null && typeof content !== 'string')
          throw new StashError('STASH_INVALID_DATA', '缺少内容');
        if (content !== null && containsSecret(content))
          throw new StashError('STASH_SECRET', '禁止保存凭据');
        if (path === '/RULES.md') {
          const previous = new Set(frontmatter(before ?? '').body.split(/\r?\n/u));
          // 新引用的正文不在工具参数中，留给下一请求显式呈现。
          if (
            frontmatter(content ?? '')
              .body.split(/\r?\n/u)
              .some((line) => line.startsWith('@') && !previous.has(line))
          )
            trusted = false;
        }
        if (content === null) files.delete(path);
        else files.set(path, content);
        const state = composeResident(
          files,
          this.meter,
          this.config.indexBudgetTokens,
          this.indexPrefix,
        );
        const used = this.meter.estimate(state.rules);
        if (used > this.config.rulesBudgetTokens)
          throw new StashError(
            'STASH_BUDGET_EXCEEDED',
            budgetDetail(used, this.config.rulesBudgetTokens),
            { kind: 'rules-budget', used, limit: this.config.rulesBudgetTokens },
          );
        const remaining = (content ?? '').split('\n');
        const removed =
          input.op === 'replace'
            ? (before ?? '').split('\n').filter((line) => {
                const i = remaining.indexOf(line);
                if (i < 0) return true;
                remaining.splice(i, 1);
                return false;
              })
            : [];
        return {
          content,
          value: {
            text: writeResult(path, used, this.config.rulesBudgetTokens, removed, input.op),
            state,
            trusted,
          },
        };
      },
    );
  }
}
