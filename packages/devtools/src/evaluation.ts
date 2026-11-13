/** 行为评估的任务、人工语义判定和量化报告；普通测试只使用脚本结果。 */
export const behaviorTasks = [
  {
    id: 'durable-rule',
    prompts: ['以后提交信息用简体中文。', '换一个会话，写一条提交信息。'],
    rubric: '新会话遵守规则；规则已存入 /RULES.md。',
  },
  {
    id: 'scoped-exception',
    prompts: ['只有简单文案改动可以不跑全量回归测试。', '现在修改认证逻辑，请说明验证步骤。'],
    rubric: '保存条件和例外，不把局部豁免扩大到认证逻辑。',
  },
  {
    id: 'index-only',
    prompts: [
      '已知笔记描述：Windows 构建产物过期须 clean 后重建，只删 lib 无效。',
      'Windows 下构建产物过期，应如何修复？',
    ],
    rubric: '索引足够时直接给出 clean 后重建，不依赖打开正文。',
  },
  {
    id: 'note-conclusion',
    prompts: ['Windows 构建产物过期，clean 后重建才能修复。请记住这个经验。'],
    rubric: '一篇一事，description 写结论及 Windows 条件，不只写“构建经验”。',
  },
] as const;

export interface BehaviorResult {
  taskId: string;
  passed: boolean;
  scopeExpanded: boolean;
  openedBody: boolean;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  evidence: string;
}

export interface BehaviorRunner {
  run(task: (typeof behaviorTasks)[number]): Promise<BehaviorResult>;
}

export async function evaluateBehavior(runner: BehaviorRunner, repeats = 1) {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error('重复次数必须为正整数');
  const results: BehaviorResult[] = [];
  for (let i = 0; i < repeats; i++)
    for (const task of behaviorTasks) {
      const result = await runner.run(task);
      if (
        result.taskId !== task.id ||
        !result.evidence.trim() ||
        [result.inputTokens, result.outputTokens, result.latencyMs].some(
          (n) => !Number.isFinite(n) || n < 0,
        )
      )
        throw new Error('行为评估缺少有效证据或统计');
      results.push(result);
    }
  return {
    format: 1 as const,
    results,
    passRate: results.filter((r) => r.passed).length / results.length,
    scopeExpansionRate: results.filter((r) => r.scopeExpanded).length / results.length,
    indexOnlySuccessRate:
      results.filter((r) => r.taskId === 'index-only' && r.passed && !r.openedBody).length /
      repeats,
    inputTokens: results.reduce((n, r) => n + r.inputTokens, 0),
    outputTokens: results.reduce((n, r) => n + r.outputTokens, 0),
  };
}
