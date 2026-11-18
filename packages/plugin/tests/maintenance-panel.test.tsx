// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
import { MaintenancePanel } from '../src/client/MaintenancePanel.tsx';
import { zh } from '../src/client/locales.ts';
import type { MaintenanceAction, MaintenanceData } from '../src/adapters/maintenance-schema.ts';

afterEach(cleanup);

it('整理页逐条确认和整组回滚均由用户触发，写后刷新失败仍标明已保存', async () => {
  const id = 'stash-maint-12345678-1234-4567-8901-123456789abc';
  const base: MaintenanceData = {
    health: {
      notes: 12,
      unread: 1,
      unreadDays: 90,
      added: 3,
      verifiedDifferent: 1,
      verifiedUnknown: 0,
      folded: true,
      rulesUsed: 42,
      rulesLimit: 200,
    },
    runs: [{ id, status: 'proposed' }],
    review: null,
    started: null,
  };
  let inspect = 0;
  const call = vi.fn(async (a: MaintenanceAction): Promise<MaintenanceData> => {
    if (a.op === 'inspect' && ++inspect === 2) throw new Error('读取失败');
    if (a.op === 'review')
      return {
        ...base,
        review: {
          id,
          revision: 'a'.repeat(64),
          changes: [{ path: '/RULES.md', before: '旧', after: '甲\n乙', redirect: null }],
          rules: [
            { line: 1, before: '旧', after: '甲' },
            { line: 2, before: null, after: '乙' },
          ],
        },
      };
    if (a.op === 'apply') base.runs = [{ id, status: 'applied' }];
    else if (a.op === 'rollback') base.runs = [{ id, status: 'reverted' }];
    return { ...base };
  });
  render(<MaintenancePanel call={call} t={(k) => zh[k]} enabled />);
  fireEvent.click(await screen.findByRole('button', { name: zh.maintReview }));
  const button = await screen.findByRole('button', { name: zh.maintApply });
  const [a, b] = screen.getAllByRole('checkbox');
  fireEvent.click(a!);
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(b!);
  fireEvent.click(button);
  await screen.findByText(zh.maintSavedRefresh);
  expect(call).toHaveBeenCalledWith({
    op: 'apply',
    id,
    revision: 'a'.repeat(64),
    confirmed: [1, 2],
  });
  fireEvent.click(screen.getByRole('button', { name: zh.maintUndo }));
  expect(call.mock.calls.some(([v]) => v.op === 'rollback')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: zh.confirm }));
  await waitFor(() => expect(call).toHaveBeenCalledWith({ op: 'rollback', id }));
});
