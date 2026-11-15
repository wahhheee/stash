import { mkdtemp, readFile, readdir, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { FileTraceSink } from '../src/adapters/trace.ts';
import { doctor, inspectRoot, readReport, writeReport } from '../src/adapters/diagnostics.ts';
import { resolveConfig } from '../src/adapters/config.ts';
import { StashRuntime } from '../src/host/runtime.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'stash-test-'));
  roots.push(root);
  return root;
}

describe('诊断基础设施', () => {
  it('配置拒绝无效保留期与级别', () => {
    expect(() => resolveConfig({ traceRetentionDays: 0 })).toThrow();
    expect(() => resolveConfig({ traceRetentionDays: 1.5 })).toThrow();
    expect(() => resolveConfig({ trace: 'invalid' as 'off' })).toThrow();
  });
  it('trace 关闭不建目录；元数据剥离正文；并发顺序与保留期正确', async () => {
    const root = await temporary();
    const memory = join(root, 'memory');
    const clock = { now: () => new Date('2026-11-11T00:00:00Z') };
    const sink = new FileTraceSink(memory, 'off', 2, clock);
    const event = {
      v: 1 as const,
      timestamp: clock.now().toISOString(),
      kind: 'diagnostic' as const,
      content: '不可泄露正文',
    };
    await sink.emit(event);
    expect(await readdir(root)).toEqual([]);
    await mkdir(join(memory, '.trace'), { recursive: true });
    await writeFile(join(memory, '.trace', '2026-11-09.jsonl'), '旧数据');
    await writeFile(join(memory, '.trace', '2026-11-10.jsonl'), '保留');
    sink.setLevel('metadata');
    await Promise.all(Array.from({ length: 20 }, (_, seq) => sink.emit({ ...event, seq })));
    await sink.flush();
    const lines = (await readFile(join(memory, '.trace', '2026-11-11.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(lines.map((line) => JSON.parse(line).seq)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );
    expect(lines.join('')).not.toContain('不可泄露');
    expect(await readdir(join(memory, '.trace'))).toEqual(['2026-11-10.jsonl', '2026-11-11.jsonl']);
  });
  it('报告剥离正文，脱敏凭据，拒绝未来版本与损坏文件', async () => {
    const root = await temporary();
    const config = {
      rulesBudgetTokens: 1600,
      indexBudgetTokens: 1600,
      viewBudgetTokens: 4000,
      externalRuleUpdates: 'next-request' as const,
      memoryRoot: root,
      trace: 'content' as const,
      traceRetentionDays: 7,
    };
    const sink = new FileTraceSink(root, 'content', 7);
    await sink.emit({
      v: 1,
      timestamp: new Date().toISOString(),
      kind: 'error',
      code: 'sk-' + 'a'.repeat(30),
      content: 'private text',
    });
    const checks = await doctor(config, '0.2.2-rc.3');
    expect(checks.every((c) => c.ok)).toBe(true);
    const report = await readReport(await writeReport(config, '0.1.0', '0.2.2-rc.3', checks));
    expect(report.phase).toBe(3);
    expect(report.trace).toHaveLength(1);
    expect(report.trace[0]).not.toHaveProperty('content');
    expect(JSON.stringify(report)).not.toContain('a'.repeat(30));
    const bad = join(root, 'bad.json.gz');
    await writeFile(bad, gzipSync(JSON.stringify({ ...report, format: 2 })));
    await expect(readReport(bad)).rejects.toThrow();
    await writeFile(bad, gzipSync(Buffer.alloc(8 * 1024 * 1024 + 1, 32)));
    await expect(readReport(bad)).rejects.toThrow();
    await writeFile(bad, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(readReport(bad)).rejects.toThrow('8 MiB');
    await writeFile(join(root, '.trace', 'broken.jsonl'), '{');
    expect((await inspectRoot(root)).some((c) => !c.ok)).toBe(true);
    expect((await doctor(config, '0.2.2-rc.1'))[0]!.ok).toBe(false);
    expect((await doctor(config, '0.2.2-rc.2'))[0]!.ok).toBe(false);
    expect((await doctor(config, '0.3.0-rc.1'))[0]!.ok).toBe(false);
  });
  it('trace 的磁盘故障不会伪装成功', async () => {
    const root = await temporary();
    await writeFile(join(root, '.trace'), '不是目录');
    const sink = new FileTraceSink(root, 'metadata', 7);
    await expect(
      sink.emit({ v: 1, timestamp: new Date().toISOString(), kind: 'error' }),
    ).rejects.toThrow();
    await expect(sink.flush()).rejects.toThrow();
  });
  it('命令严格解析，trace 切换仅影响本实例', async () => {
    const root = await temporary();
    const config = {
      rulesBudgetTokens: 1600,
      indexBudgetTokens: 1600,
      viewBudgetTokens: 4000,
      externalRuleUpdates: 'next-request' as const,
      memoryRoot: root,
      trace: 'off' as const,
      traceRetentionDays: 7,
    };
    const runtime = new StashRuntime(config, '0.1.0', '0.2.2-rc.3');
    expect((await runtime.command('status extra')).kind).toBe('error');
    expect((await runtime.command('trace metadata')).kind).toBe('success');
    expect(runtime.status().trace).toBe('metadata');
    expect(config.trace).toBe('off');
    expect((await runtime.command('doctor --bundle')).text).toContain('bundle:');
    expect((await runtime.command('doctor --unknown')).kind).toBe('error');
    const files = await readdir(join(root, '.trace'));
    const events = (await readFile(join(root, '.trace', files[0]!), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'STASH_DOCTOR_OK' })]),
    );
  });
});
