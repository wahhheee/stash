import {
  memoryPath,
  NO_CHANGES,
  parseNote,
  resolveRedirect,
  redirectNotice,
  StashError,
  COMPACTION_REFERENCE,
  type PlanChange,
  type PlanStep,
  type TokenEstimator,
} from '@wahhheee/stash-core';
import { editStage, stagePreview, type StageEdit } from '../adapters/stage-files.ts';
import { containsSecret } from '../adapters/redaction.ts';
import { StagePages } from './stage-session.ts';

export interface CopyTree {
  files: Map<string, string>;
  aliases: Map<string, string>;
}

export interface CopyDelta {
  changes: PlanChange[];
  files: ReadonlyMap<string, string>;
}

/** 临时副本使用与整理会话相同的编辑器；不把整库正文送进即将压缩的上下文。 */
export class CompactionCopy {
  private pages: StagePages;
  private version = 0;
  private checked = -1;
  private trees: CopyTree[];

  constructor(
    private base: readonly [CopyTree, CopyTree],
    meter: TokenEstimator,
    budget: number,
    private workspace = true,
  ) {
    this.pages = new StagePages(meter, budget);
    this.trees = base.map((t) => ({ files: new Map(t.files), aliases: new Map(t.aliases) }));
  }

  async view(path: string, cursor?: string) {
    const local = path.startsWith('./');
    if (!local && !this.workspace) throw new StashError('STASH_DISABLED', '不继承工作区');
    const p = memoryPath(local ? path.slice(1) : path);
    const { files, aliases } = this.trees[local ? 1 : 0]!;
    let text: string;
    if (p === '/.guide.md') text = COMPACTION_REFERENCE;
    else if (p === '/notes' || p.endsWith('/')) {
      text = [...files]
        .filter(([k]) => k.startsWith(p))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([k, v]) =>
            (local ? '.' : '') +
            k +
            (k.startsWith('/notes/') ? ': ' + String(parseNote(v).fields.description) : ''),
        )
        .join('\n');
    } else {
      const target = resolveRedirect(p, aliases),
        content = files.get(target);
      if (content === undefined) throw new StashError('STASH_NOT_FOUND', '文件不存在');
      text = (target === p ? '' : redirectNotice(path, (local ? '.' : '') + target)) + content;
    }
    if (containsSecret(text)) throw new StashError('STASH_SECRET', '副本包含凭据');
    return this.pages.page(`${this.version}:${path}`, text, cursor, () => {});
  }

  async edit(edit: StageEdit) {
    if (edit.kind === 'reset')
      this.trees = this.base.map((t) => ({ files: new Map(t.files), aliases: new Map(t.aliases) }));
    else {
      const path =
        edit.kind === 'write'
          ? edit.input.path
          : 'path' in edit.step
            ? edit.step.path
            : '/RULES.md';
      const local = path.startsWith('./');
      if (!local && !this.workspace) throw new StashError('STASH_DISABLED', '不继承工作区');
      const normalize = (p: string) => {
        if (local !== p.startsWith('./'))
          throw new StashError('STASH_UNSUPPORTED', '跨层迁移请分别编辑两层副本');
        return memoryPath(local ? p.slice(1) : p, true);
      };
      const tree = this.trees[local ? 1 : 0]!;
      const files = new Map(tree.files),
        aliases = new Map(tree.aliases);
      if (edit.kind === 'write')
        editStage(files, aliases, {
          kind: 'write',
          input: { ...edit.input, path: normalize(path) },
        });
      else {
        const s = edit.step;
        let step: PlanStep;
        if (s.op === 'move') step = { ...s, path: normalize(s.path), to: normalize(s.to) };
        else if (s.op === 'merge')
          step = { ...s, path: normalize(s.path), from: s.from.map(normalize) };
        else if (s.op === 'split')
          step = {
            ...s,
            path: normalize(s.path),
            parts: s.parts.map((i) => ({ ...i, path: normalize(i.path) })),
          };
        else throw new StashError('STASH_UNSUPPORTED', '未知结构操作');
        editStage(files, aliases, { kind: 'organize', step });
      }
      this.trees[local ? 1 : 0] = { files, aliases };
    }
    this.version++;
    this.checked = -1;
    this.pages.clear();
  }

  private delta(i: 0 | 1): CopyDelta {
    const t = this.trees[i]!,
      b = this.base[i];
    return {
      files: t.files,
      changes: stagePreview(b.files, t.files, b.aliases, t.aliases).changes,
    };
  }

  async diff(cursor?: string) {
    const rows = [
      ...this.delta(0).changes,
      ...this.delta(1).changes.map((c) => ({
        ...c,
        path: '.' + c.path,
        redirect: c.redirect ? '.' + c.redirect : null,
      })),
    ];
    const text = rows.length ? JSON.stringify(rows) : NO_CHANGES;
    if (containsSecret(text)) throw new StashError('STASH_SECRET', '差异包含凭据');
    return this.pages.page(`${this.version}:diff`, text, cursor, () => {
      this.checked = this.version;
    });
  }

  submission(): [CopyDelta, CopyDelta] {
    if (this.checked !== this.version)
      throw new StashError('STASH_STALE_READ', '请核对最终差异', { kind: 'maintenance-diff' });
    return [this.delta(0), this.delta(1)];
  }
}
