import { composeResident, expandRules, healthCounts, StashError } from '@wahhheee/stash-core';
import type { MemoryBudgets, TokenEstimator } from '@wahhheee/stash-core';
import type { FileMemoryStore } from '../adapters/memory-store.ts';
import { readHead } from '../adapters/git-head.ts';

export function validatePlan(
  files: ReadonlyMap<string, string>,
  meter: TokenEstimator,
  config: MemoryBudgets,
) {
  const used = meter.estimate(expandRules(files));
  if (used > config.rulesBudgetTokens)
    throw new StashError('STASH_BUDGET_EXCEEDED', '整理后的规则超出预算', {
      kind: 'rules-budget',
      used,
      limit: config.rulesBudgetTokens,
    });
}

export async function inspectMaintenance(
  store: FileMemoryStore,
  id: string,
  cwd: string,
  meter: TokenEstimator,
  config: MemoryBudgets & { unreadDays: number },
  archivedIds: () => readonly string[],
) {
  const { files, usage, runs, lastRun } = await store.maintenanceState(id);
  const state = composeResident(files, meter, config.indexBudgetTokens);
  const head = await readHead(cwd);
  const archived = new Set(archivedIds());
  return {
    health: {
      ...healthCounts(files, usage, Date.now(), config.unreadDays, lastRun, head),
      unreadDays: config.unreadDays,
      folded: state.folded,
      rulesUsed: meter.estimate(state.rules),
      rulesLimit: config.rulesBudgetTokens,
    },
    runs: runs.flatMap((run) =>
      !archived.has(run.id)
        ? [run]
        : run.status === 'applied' || run.status === 'reverted'
          ? [{ ...run, archived: true as const }]
          : [],
    ),
  };
}
