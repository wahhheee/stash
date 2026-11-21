import { expect, it } from 'vitest';
import { CompactionCopy } from '../src/host/compaction-copy.ts';

const original = '---\ntype: finding\ndescription: 原始结论\n---\n只在这次核对中成立。';

const tree = () => ({
  files: new Map([['/notes/old.md', original]]),
  aliases: new Map<string, string>(),
});

const meter = { estimate: (s: string) => s.length };

it('会话副本可单独改名和回读，重置不影响正式记忆或另一个层的同名文件', async () => {
  const base = [tree(), tree()] as const;
  const copy = new CompactionCopy(base, meter, 4000);
  const move = (name: string, to: string) =>
    copy.edit({
      kind: 'organize',
      step: { op: 'move', path: './notes/' + name + '.md', to: './notes/' + to + '.md' },
    });
  await move('old', 'mid');
  await copy.diff();
  await move('mid', 'new');
  expect(() => copy.submission()).toThrow();
  expect(await copy.view('./notes/old.md')).toContain('→ ./notes/new.md');
  expect(await copy.view('/notes/old.md')).not.toContain('Redirect:');
  await copy.diff();
  const [w, s] = copy.submission();
  expect(w.changes).toEqual([]);
  expect(s.changes.find((c) => c.path === '/notes/old.md')?.redirect).toBe('/notes/new.md');
  expect(s.changes.some((c) => c.path === '/notes/mid.md')).toBe(false);
  expect(base[1].files.has('/notes/new.md')).toBe(false);
  await copy.edit({ kind: 'reset' });
  await copy.diff();
  expect(copy.submission().flatMap((d) => d.changes)).toEqual([]);
});

it('干净会话保留会话层，不能通过结构操作改动工作区', async () => {
  const copy = new CompactionCopy([tree(), tree()], meter, 4000, false);
  expect(await copy.view('./notes/')).toContain('./notes/old.md');
  await expect(copy.view('/notes/')).rejects.toMatchObject({ code: 'STASH_DISABLED' });
  await expect(
    copy.edit({
      kind: 'organize',
      step: { op: 'move', path: './notes/old.md', to: '/notes/new.md' },
    }),
  ).rejects.toMatchObject({ code: 'STASH_UNSUPPORTED' });
  await copy.diff();
  expect(copy.submission().flatMap((d) => d.changes)).toEqual([]);
});
