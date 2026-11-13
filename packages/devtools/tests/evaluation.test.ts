import { expect, it } from 'vitest';
import { evaluateBehavior } from '../src/evaluation.ts';

it('评估框架汇总重复运行并区分条件扩大和索引直接成功', async () => {
  const report = await evaluateBehavior(
    {
      run: async (task) => ({
        taskId: task.id,
        passed: task.id !== 'scoped-exception',
        scopeExpanded: task.id === 'scoped-exception',
        openedBody: false,
        inputTokens: 10,
        outputTokens: 2,
        latencyMs: 1,
        evidence: '脚本结果，仅验证统计框架',
      }),
    },
    2,
  );
  expect(report).toMatchObject({
    format: 1,
    passRate: 0.75,
    scopeExpansionRate: 0.25,
    indexOnlySuccessRate: 1,
    inputTokens: 80,
    outputTokens: 16,
  });
});
