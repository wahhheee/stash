import { isAbsolute, join, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import { resolveDshHome, expandHomePath } from '@deepseek-ai/dsh-home-paths';
import type { TraceLevel } from '@wahhheee/stash-core';

export interface Config {
  enabled?: boolean;
  compactionNotes?: boolean;
  subagentWrite?: boolean;
  trace?: TraceLevel;
  traceRetentionDays?: number;
  memoryRoot?: string;
  unreadDays?: number;
  maintenanceModel?: string;
  rulesBudgetTokens?: number;
  indexBudgetTokens?: number;
  viewBudgetTokens?: number;
  externalRuleUpdates?: 'next-request' | 'next-compaction';
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('记忆总开关。'),
  compactionNotes: Schema.boolean()
    .default(true)
    .description('开启后，模型可以在 DSH 生成摘要前把有用的结论补记到 stash，无需你审核。')
    .volatile(),
  subagentWrite: Schema.boolean().default(false).description('允许子代理写入记忆。'),
  trace: Schema.union(['off', 'metadata', 'content'])
    .default('off')
    .description('Trace 级别；content 包含正文。'),
  traceRetentionDays: Schema.number()
    .step(1)
    .min(1)
    .max(365)
    .default(7)
    .description('Trace 保留天数（UTC 日历日）。'),
  unreadDays: Schema.number().step(1).min(1).max(3650).default(90).description('长期未读的天数。'),
  maintenanceModel: Schema.string().description('整理会话的模型 ID，沿用发起会话的提供商。'),
  memoryRoot: Schema.string().description('记忆根目录；相对路径以 DSH_HOME 为基准。'),
  rulesBudgetTokens: Schema.number()
    .step(1)
    .min(128)
    .max(32000)
    .default(1600)
    .description('工作区和会话层各自的规则预算。'),
  indexBudgetTokens: Schema.number()
    .step(1)
    .min(128)
    .max(32000)
    .default(1600)
    .description('工作区和会话层各自的常驻笔记索引预算。'),
  viewBudgetTokens: Schema.number()
    .step(1)
    .min(256)
    .max(64000)
    .default(4000)
    .description('单次读取预算。'),
  externalRuleUpdates: Schema.union(['next-request', 'next-compaction'])
    .default('next-request')
    .description('外部规则更新时机。'),
});

export interface ResolvedConfig {
  enabled: boolean;
  subagentWrite: boolean;
  trace: TraceLevel;
  traceRetentionDays: number;
  memoryRoot: string;
  unreadDays: number;
  maintenanceModel: string;
  rulesBudgetTokens: number;
  indexBudgetTokens: number;
  viewBudgetTokens: number;
  externalRuleUpdates: 'next-request' | 'next-compaction';
}

export function resolveConfig(input: Config = {}): ResolvedConfig {
  return resolveHostConfig(Config(input));
}

export function resolveHostConfig(config: ReturnType<typeof Config>): ResolvedConfig {
  const home = resolveDshHome();
  const root = config.memoryRoot?.trim();
  const expanded = root ? expandHomePath(root) : join(home, 'memory');
  return {
    enabled: config.enabled ?? true,
    subagentWrite: config.subagentWrite ?? false,
    trace: config.trace ?? 'off',
    rulesBudgetTokens: config.rulesBudgetTokens ?? 1600,
    indexBudgetTokens: config.indexBudgetTokens ?? 1600,
    viewBudgetTokens: config.viewBudgetTokens ?? 4000,
    externalRuleUpdates: config.externalRuleUpdates ?? 'next-request',
    traceRetentionDays: config.traceRetentionDays ?? 7,
    unreadDays: config.unreadDays ?? 90,
    maintenanceModel: config.maintenanceModel?.trim() ?? '',
    memoryRoot: isAbsolute(expanded) ? expanded : resolve(home, expanded),
  };
}
