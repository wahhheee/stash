import { isAbsolute, join, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { resolveDshHome, expandHomePath } from '@deepseek-ai/dsh-home-paths';
import type { TraceLevel } from '@wahhheee/stash-core';

export interface Config {
  trace?: TraceLevel;
  traceRetentionDays?: number;
  memoryRoot?: string;
}

export const Config: Schema<Config> = Schema.object({
  trace: Schema.union(['off', 'metadata', 'content'])
    .default('off')
    .description('Trace 级别；content 包含正文。'),
  traceRetentionDays: Schema.number()
    .step(1)
    .min(1)
    .max(365)
    .default(7)
    .description('Trace 保留天数（UTC 日历日）。'),
  memoryRoot: Schema.string().description('记忆根目录；相对路径以 DSH_HOME 为基准。'),
});

export interface ResolvedConfig {
  trace: TraceLevel;
  traceRetentionDays: number;
  memoryRoot: string;
}

export function resolveConfig(input: Config = {}): ResolvedConfig {
  const config = Config(input);
  const home = resolveDshHome();
  const root = config.memoryRoot?.trim();
  const expanded = root ? expandHomePath(root) : join(home, 'memory');
  return {
    trace: config.trace ?? 'off',
    traceRetentionDays: config.traceRetentionDays ?? 7,
    memoryRoot: isAbsolute(expanded) ? expanded : resolve(home, expanded),
  };
}
