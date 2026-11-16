import { foldLog } from './fold.ts';
import { resolve, dirname, basename } from 'node:path';
import { inspectRoot, readReport } from '../../plugin/src/adapters/diagnostics.ts';
import { FileMemoryStore } from '../../plugin/src/adapters/memory-store.ts';
import { composeResident, fullContext, GUIDE, memoryPath, parseNote } from '@wahhheee/stash-core';
import { offlineMeter, reconcile } from './reconcile.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { viewHistory } from './history.ts';

const [command, target, ...extra] = process.argv.slice(2);

const usage =
  '用法：pnpm devtools verify <记忆根目录或报告包> | render <工作区目录> | view <工作区目录> <记忆路径> [<宿主 sessions 目录> <当前会话 ID> [查询选项 JSON]] | fold <宿主 sessions 目录> <会话 ID> | journal <工作区目录> | reconcile <工作区目录> <宿主 sessions 目录> <会话 ID>';

try {
  const arity: Record<string, number> = {
    fold: 1,
    verify: 0,
    render: 0,
    view: 1,
    journal: 0,
    reconcile: 2,
  };
  if (
    !command ||
    !target ||
    (arity[command] !== extra.length && !(command === 'view' && [3, 4].includes(extra.length)))
  ) {
    console.error(usage);
    process.exitCode = 2;
  } else if (command === 'fold') {
    for (const step of await foldLog(resolve(target), extra[0]!)) console.log(JSON.stringify(step));
  } else if (command === 'verify') {
    const checks = target.endsWith('.json.gz')
      ? (await readReport(target)).checks
      : await inspectRoot(target);
    for (const check of checks)
      console.log((check.ok ? 'OK ' : 'FAIL ') + check.name + ': ' + check.detail);
    process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
  } else {
    const dir = resolve(target);
    const store = new FileMemoryStore(dirname(dir));
    const id = basename(dir);
    await store.validateWorkspace(id);
    if (command === 'view' && extra.length >= 3) {
      const meta = z
        .object({ path: z.string() })
        .parse(JSON.parse(await readFile(join(dir, 'workspace.json'), 'utf8')));
      const options = z
        .object({
          query: z.string().optional(),
          since: z.string().optional(),
          until: z.string().optional(),
          detail: z.enum(['brief', 'full']).optional(),
          all: z.boolean().optional(),
        })
        .strict()
        .parse(extra[3] ? JSON.parse(extra[3]) : {});
      console.log(
        await viewHistory(resolve(extra[1]!), meta.path, extra[2]!, {
          ...options,
          path: extra[0]!,
        }),
      );
    } else if (command === 'journal') {
      for (const change of await store.journal(id)) console.log(JSON.stringify(change));
    } else if (command === 'reconcile')
      console.log((await reconcile(dirname(dir), id, extra[0]!, extra[1]!)).join('\n'));
    else {
      const files = await store.snapshot(id, true);
      if (command === 'render') {
        const state = composeResident(files, offlineMeter, 1600);
        console.log(fullContext(id, state.rules, state.index, state.folded));
      } else {
        const path = memoryPath(extra[0]!);
        if (path === '/.guide.md') console.log(GUIDE);
        else if (path === '/' || path === '/notes' || path.endsWith('/'))
          console.log(
            [...files]
              .filter(([p]) => path === '/' || p.startsWith(path === '/notes' ? '/notes/' : path))
              .map(
                ([p, text]) =>
                  p +
                  (p.startsWith('/notes/')
                    ? ': ' + String(parseNote(text).fields.description)
                    : ''),
              )
              .join('\n'),
          );
        else {
          const text = files.get(path);
          if (text === undefined) throw new Error('文件不存在');
          console.log(text);
        }
      }
    }
  }
} catch (error) {
  console.error('检查失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
}
