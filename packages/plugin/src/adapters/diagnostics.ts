import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  open,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { satisfies } from 'semver';
import { z } from 'zod';
import { redact } from './redaction.ts';
import type { ResolvedConfig } from './config.ts';

export const SUPPORTED_DSH = '>=0.2.2-rc.1 <0.3.0-0';

export const TraceSchema = z
  .object({
    v: z.literal(1),
    timestamp: z.iso.datetime(),
    kind: z.enum([
      'plugin.start',
      'plugin.stop',
      'diagnostic',
      'inject.decide',
      'inject.emit',
      'tool.view',
      'tool.write',
      'commit.fold',
      'external.detect',
      'switch.change',
      'lock.wait',
      'error',
    ]),
    callId: z.string().optional(),
    sessionId: z.string().optional(),
    seq: z.number().int().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    tokens: z.number().nonnegative().optional(),
    hash: z.string().optional(),
    code: z.string().optional(),
    decision: z.enum(['none', 'full', 'delta']).optional(),
    content: z.string().optional(),
  })
  .strict();

const CheckSchema = z.object({ name: z.string(), ok: z.boolean(), detail: z.string() }).strict();
export type Check = z.infer<typeof CheckSchema>;

export const ReportSchema = z
  .object({
    format: z.literal(1),
    createdAt: z.iso.datetime(),
    version: z.string(),
    hostVersion: z.string(),
    phase: z.literal(1),
    config: z
      .object({
        trace: z.enum(['off', 'metadata', 'content']),
        traceRetentionDays: z.number().int().min(1).max(365),
        memoryRoot: z.string(),
      })
      .strict(),
    checks: z.array(CheckSchema),
    trace: z.array(TraceSchema.omit({ content: true }).strict()),
  })
  .strict();

export type Report = z.infer<typeof ReportSchema>;
const MAX_BYTES = 8 * 1024 * 1024;

async function boundedRead(path: string): Promise<Buffer> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('文件不是普通文件或超过 8 MiB');
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino)
      throw new Error('读取期间文件已替换');
    const chunks: Buffer[] = [];
    let total = 0;
    // 不依赖最初的 stat 大小；并发追加也不能突破读取上限。
    while (total <= MAX_BYTES) {
      const chunk = Buffer.alloc(Math.min(65536, MAX_BYTES + 1 - total));
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) return Buffer.concat(chunks, total);
      total += bytesRead;
      chunks.push(chunk.subarray(0, bytesRead));
    }
    throw new Error('文件超过 8 MiB');
  } finally {
    await file.close();
  }
}

/** 离线检查只读；不存在的根目录作为未初始化状态报告。 */
export async function inspectRoot(root: string): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const stat = await lstat(root);
    if (!stat.isDirectory())
      return [{ name: 'memoryRoot', ok: false, detail: '根目录不是普通目录' }];
    await access(root, constants.R_OK);
    checks.push({ name: 'memoryRoot', ok: true, detail: '目录可读' });
  } catch (error) {
    return [
      {
        name: 'memoryRoot',
        ok: false,
        detail:
          (error as NodeJS.ErrnoException).code === 'ENOENT' ? '目录尚未初始化' : '目录不可读',
      },
    ];
  }
  const trace = join(root, '.trace');
  try {
    const stat = await lstat(trace);
    if (!stat.isDirectory()) throw new Error('trace 不是普通目录');
    for (const file of await readdir(trace, { withFileTypes: true })) {
      if (!file.name.endsWith('.jsonl')) continue;
      try {
        const lines = (await boundedRead(join(trace, file.name)))
          .toString('utf8')
          .split('\n')
          .filter(Boolean);
        for (const line of lines) TraceSchema.parse(JSON.parse(line));
        checks.push({
          name: '.trace/' + file.name,
          ok: true,
          detail: String(lines.length) + ' 条有效事件',
        });
      } catch {
        checks.push({ name: '.trace/' + file.name, ok: false, detail: '格式、版本或文件类型无效' });
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      checks.push({ name: 'trace', ok: false, detail: 'trace 目录不可读' });
  }
  return checks;
}

export async function doctor(config: ResolvedConfig, hostVersion: string): Promise<Check[]> {
  const checks: Check[] = [
    {
      name: 'dsh',
      ok: satisfies(hostVersion, SUPPORTED_DSH, { includePrerelease: true }),
      detail: hostVersion + ' / ' + SUPPORTED_DSH,
    },
  ];
  let probe: string | undefined;
  try {
    await mkdir(config.memoryRoot, { recursive: true });
    probe = await mkdtemp(join(config.memoryRoot, '.doctor-'));
    const file = join(probe, 'probe');
    await writeFile(file, 'stash', { flag: 'wx', mode: 0o600 });
    await unlink(file);
    checks.push({ name: 'write', ok: true, detail: '可创建、写入和删除文件' });
  } catch {
    checks.push({ name: 'write', ok: false, detail: '记忆根目录写入检查失败' });
  } finally {
    if (probe)
      await rmdir(probe).catch(() => {
        checks.push({ name: 'cleanup', ok: false, detail: '检查临时目录清理失败' });
      });
  }
  return [...checks, ...(await inspectRoot(config.memoryRoot))];
}

export async function writeReport(
  config: ResolvedConfig,
  version: string,
  hostVersion: string,
  checks: Check[],
): Promise<string> {
  const trace: Report['trace'] = [];
  const directory = join(config.memoryRoot, '.trace');
  try {
    // 报告有界，只采最近七个文件中的最后 200 条；始终剥离正文。
    for (const name of (await readdir(directory))
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(n))
      .sort()
      .slice(-7)) {
      const lines = (await boundedRead(join(directory, name)))
        .toString('utf8')
        .split('\n')
        .filter(Boolean);
      for (const line of lines.slice(-200)) {
        const parsed = TraceSchema.safeParse(JSON.parse(line));
        if (parsed.success)
          trace.push(TraceSchema.omit({ content: true }).strip().parse(parsed.data));
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      checks = [...checks, { name: 'report.trace', ok: false, detail: '部分 trace 无法附带' }];
  }
  const report = ReportSchema.parse({
    format: 1,
    createdAt: new Date().toISOString(),
    version,
    hostVersion,
    phase: 1,
    config,
    checks,
    trace: trace.slice(-200),
  });
  const reports = join(config.memoryRoot, '.reports');
  await mkdir(reports, { recursive: true });
  const path = join(reports, 'stash-' + randomUUID() + '.json.gz');
  await writeFile(path, gzipSync(redact(JSON.stringify(report))), { flag: 'wx', mode: 0o600 });
  return path;
}

export async function readReport(path: string): Promise<Report> {
  const bytes = await boundedRead(path);
  return ReportSchema.parse(
    JSON.parse(gunzipSync(bytes, { maxOutputLength: MAX_BYTES }).toString('utf8')),
  );
}
