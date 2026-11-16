import { expect, it } from 'vitest';
import {
  DEFAULT_SWITCHES,
  resolveSwitches,
  decideResident,
  renderResident,
  foldResident,
} from '../src/index.ts';

it('三级开关穷举：全局硬闸与最近明确设置，隐私和继承独立', () => {
  for (const global of [true, false])
    for (const workspace of [true, false, null])
      for (const session of [true, false, null]) {
        const result = resolveSwitches(
          global,
          { ...DEFAULT_SWITCHES, enabled: workspace, writable: workspace },
          {
            ...DEFAULT_SWITCHES,
            enabled: session,
            writable: session,
            discoverable: false,
            inheritWorkspace: false,
          },
        );
        expect(result.enabled).toBe(global && (session ?? workspace ?? true));
        expect(result.writable).toBe(result.enabled && (session ?? workspace ?? true));
        expect(result.discoverable).toBe(false);
        expect(result.inheritWorkspace).toBe(false);
      }
});

it('首请求关闭不通知，开关变化刷新完整快照且干净模式无工作区正文', () => {
  const state = {
    rules: 'workspace secret rule',
    index: 'UNIQUE_INDEX_SENTINEL',
    folded: false,
    session: { id: 's', rules: 'session rule', index: '', folded: false },
  };
  const meter = { estimate: (text: string) => text.length / 4 };
  const config = {
    rulesBudgetTokens: 1600,
    indexBudgetTokens: 1600,
    viewBudgetTokens: 4000,
    externalRuleUpdates: 'next-request' as const,
  };
  expect(decideResident(null, { ...state, disabled: true }, 'w', meter, config).kind).toBe('none');
  expect(decideResident(state, { ...state, disabled: true }, 'w', meter, config).text).toContain(
    'Memory is off',
  );
  expect(decideResident({ ...state, disabled: true }, state, 'w', meter, config).kind).toBe('full');
  const clean = { ...state, clean: true, policyReadOnly: true };
  const text = renderResident('w', clean);
  expect(text).not.toContain('workspace secret rule');
  expect(text).not.toContain('UNIQUE_INDEX_SENTINEL');
  expect(text).toContain('session rule');
  expect(text).toContain('read-only');
  const folded = foldResident(
    [
      { v: 1, workspaceId: 'w', kind: 'full', state: clean },
      { v: 1, workspaceId: 'w', kind: 'write', scope: 'session', state: clean },
    ],
    'w',
  );
  expect(folded?.clean).toBe(true);
});
