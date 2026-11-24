import * as fs from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { FileMemoryStore } from '../src/adapters/memory-store.ts';
import { memoryFile } from '../src/adapters/revision.ts';

vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof fs>();
  return {
    ...real,
    open: vi.fn(real.open),
    rename: vi.fn(real.rename),
    unlink: vi.fn(real.unlink),
  };
});

const real = await vi.importActual<typeof fs>('node:fs/promises');
let home: string;

async function fixture() {
  home = await fs.mkdtemp(join(tmpdir(), 'stash-fault-'));
  const root = join(home, 'memory'),
    store = new FileMemoryStore(root);
  await store.ensure({ format: 1, id: 'w', path: home, title: '测试' });
  const initial = await store.write('w', '/RULES.md', '旧规则', null);
  return {
    store,
    dir: store.directory('w'),
    cold: () => new FileMemoryStore(root),
    write: () => store.write('w', '/RULES.md', '新规则', initial.after!.revision),
  };
}

afterEach(async () => {
  vi.mocked(fs.open).mockReset();
  vi.mocked(fs.rename).mockReset();
  vi.mocked(fs.unlink).mockReset();
  if (home) await fs.rm(home, { recursive: true, force: true });
});

it.each(['只读目录', '暂存刷盘', '登记意图', '替换正文', '追加日志', '清除意图'])(
  '%s 故障必须报错，重启后只出现完整的旧版或新版',
  async (point) => {
    const f = await fixture();
    let fired = false;
    const fail = () => {
      fired = true;
      return Object.assign(new Error(point), { code: point === '只读目录' ? 'EROFS' : 'EIO' });
    };
    vi.mocked(fs.open).mockImplementation(async (path, ...args) => {
      const name = basename(String(path));
      if (
        !fired &&
        ((point === '只读目录' && name === '.lock') ||
          (point === '追加日志' && name === '.journal.jsonl' && args[0] === 'a'))
      )
        throw fail();
      const file = await real.open(path, ...args);
      if (!fired && point === '暂存刷盘' && name.startsWith('.tmp-'))
        vi.spyOn(file, 'sync').mockRejectedValueOnce(fail());
      return file;
    });
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      if (
        !fired &&
        ((point === '登记意图' && basename(String(to)) === '.pending.json') ||
          (point === '替换正文' && basename(String(to)) === 'RULES.md'))
      )
        throw fail();
      return real.rename(from, to);
    });
    vi.mocked(fs.unlink).mockImplementation(async (path) => {
      if (!fired && point === '清除意图' && basename(String(path)) === '.pending.json')
        throw fail();
      return real.unlink(path);
    });
    await expect(f.write()).rejects.toThrow(point);
    const committed = ['替换正文', '追加日志', '清除意图'].includes(point);
    for (let i = 0; i < 2; i++) {
      const store = f.cold();
      expect((await store.snapshot('w')).get('/RULES.md')).toBe(committed ? '新规则' : '旧规则');
      expect((await store.journal('w')).map((c) => c.after?.content)).toEqual(
        committed ? ['旧规则', '新规则'] : ['旧规则'],
      );
    }
    expect(
      (await fs.readdir(f.dir)).filter(
        (n) => n === '.lock' || n === '.pending.json' || n.startsWith('.tmp-'),
      ),
    ).toEqual([]);
  },
);

it('残留锁超时，不接管、不改写原件', async () => {
  const f = await fixture(),
    lock = join(f.dir, '.lock');
  await fs.writeFile(lock, '其他进程的锁');
  await expect(f.write()).rejects.toMatchObject({ code: 'STASH_LOCKED' });
  expect(await fs.readFile(lock, 'utf8')).toBe('其他进程的锁');
  expect(await fs.readFile(join(f.dir, 'RULES.md'), 'utf8')).toBe('旧规则');
});

it('已入日志的意图遇到外部回退，保留文件与恢复证据；无效整理归属也不重放', async () => {
  const f = await fixture();
  await f.write();
  const c = (await f.store.journal('w')).at(-1)!;
  const log = join(f.dir, '.journal.jsonl'),
    pending = join(f.dir, '.pending.json'),
    file = join(f.dir, 'RULES.md');
  const before = await fs.readFile(log);
  await fs.writeFile(file, '旧规则');
  for (const [intent, code] of [
    [c, 'STASH_STALE_READ'],
    [{ ...c, op: 'maintenance', after: memoryFile('不应落盘') }, 'STASH_INVALID_DATA'],
  ] as const) {
    const text = JSON.stringify(intent);
    await fs.writeFile(pending, text);
    await expect(f.cold().snapshot('w')).rejects.toMatchObject({ code });
    expect(await fs.readFile(file, 'utf8')).toBe('旧规则');
    expect(await fs.readFile(pending, 'utf8')).toBe(text);
    expect(await fs.readFile(log)).toEqual(before);
  }
});
