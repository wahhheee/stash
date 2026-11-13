import { FileTraceSink } from '../adapters/trace.ts';
import { doctor, writeReport } from '../adapters/diagnostics.ts';
import type { ResolvedConfig } from '../adapters/config.ts';
import type { StashStatus } from '../types.ts';

export class StashRuntime {
  readonly trace: FileTraceSink;

  constructor(
    readonly config: ResolvedConfig,
    readonly version: string,
    readonly hostVersion: string,
  ) {
    this.trace = new FileTraceSink(config.memoryRoot, config.trace, config.traceRetentionDays);
  }

  status(): StashStatus {
    return {
      version: this.version,
      hostVersion: this.hostVersion,
      phase: 2,
      memoryEnabled: true,
      trace: this.trace.getLevel(),
    };
  }

  async command(
    raw: string,
    callId?: string,
  ): Promise<{ kind: 'success' | 'error'; text: string }> {
    const args = raw.trim().split(/\s+/u);
    if (args[0] === 'status' && args.length === 1)
      return {
        kind: 'success',
        text: [
          'stash ' + this.version,
          'DSH ' + this.hostVersion,
          '阶段：2（工作区记忆与常驻层已启用）',
          'memoryRoot: ' + this.config.memoryRoot,
          'trace: ' + this.trace.getLevel(),
        ].join('\n'),
      };
    if (
      args[0] === 'trace' &&
      args.length === 2 &&
      (args[1] === 'off' || args[1] === 'metadata' || args[1] === 'content')
    ) {
      // 即使已有写盘故障，关闭也立即阻止新事件进入队列。
      if (args[1] === 'off') this.trace.setLevel('off');
      await this.trace.flush();
      this.trace.setLevel(args[1]);
      await this.trace.emit({
        v: 1,
        timestamp: new Date().toISOString(),
        kind: 'diagnostic',
        code: 'STASH_TRACE_' + args[1].toUpperCase(),
        ...(callId === undefined ? {} : { callId }),
      });
      return {
        kind: 'success',
        text: 'trace: ' + args[1] + '（当前进程；持久配置请修改插件设置）',
      };
    }
    if (
      args[0] === 'doctor' &&
      (args.length === 1 || (args.length === 2 && args[1] === '--bundle'))
    ) {
      await this.trace.flush();
      const config = { ...this.config, trace: this.trace.getLevel() };
      const started = performance.now();
      const checks = await doctor(config, this.hostVersion);
      await this.trace.emit({
        v: 1,
        timestamp: new Date().toISOString(),
        kind: 'diagnostic',
        code: checks.every((c) => c.ok) ? 'STASH_DOCTOR_OK' : 'STASH_DOCTOR_FAILED',
        durationMs: performance.now() - started,
        ...(callId === undefined ? {} : { callId }),
      });
      const lines = checks.map((c) => (c.ok ? 'OK ' : 'FAIL ') + c.name + ': ' + c.detail);
      if (args[1])
        lines.push(
          'bundle: ' + (await writeReport(config, this.version, this.hostVersion, checks)),
        );
      return { kind: checks.every((c) => c.ok) ? 'success' : 'error', text: lines.join('\n') };
    }
    return {
      kind: 'error',
      text: '用法：/stash status | doctor [--bundle] | trace off|metadata|content',
    };
  }
}
