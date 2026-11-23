// @vitest-environment jsdom
import { act, cleanup, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { it, expect, vi, afterEach } from 'vitest';
import { MaintenancePanel } from '../src/client/MaintenancePanel.tsx';
import { zh } from '../src/client/locales.ts';
import type { MaintenanceAction, MaintenanceData } from '../src/adapters/maintenance-schema.ts';

afterEach(cleanup);

const id = 'stash-maint-12345678-1234-4567-8901-123456789abc';

function sample(): MaintenanceData {
  return {
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
}

it('整理页逐条确认和整组回滚均由用户触发，写后刷新失败仍标明已保存', async () => {
  const base = sample();
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
  expect(
    screen.getByText(JSON.stringify([{ path: '/RULES.md', oldText: '旧', newText: '甲\n乙' }])),
  ).toBeDefined();
  const [all, a] = screen.getAllByRole('checkbox');
  fireEvent.click(a!);
  expect(button.hasAttribute('disabled')).toBe(true);
  expect((all as HTMLInputElement).indeterminate).toBe(true);
  fireEvent.click(all!);
  expect(button.hasAttribute('disabled')).toBe(false);
  fireEvent.click(all!);
  expect(button.hasAttribute('disabled')).toBe(true);
  fireEvent.click(all!);
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
  fireEvent.click(screen.getByRole('button', { name: zh.maintUndoConfirm }));
  await waitFor(() => expect(call).toHaveBeenCalledWith({ op: 'rollback', id }));
});

it('继续已有会话不触发新建，编号不是按钮，概况默认收起', async () => {
  const base = sample();
  base.runs[0]!.status = 'planning';
  const open = vi.fn();
  const call = vi.fn(async (action: MaintenanceAction) => ({
    ...base,
    started: action.op === 'start' ? 'stash-maint-' + action.requestId : null,
  }));
  render(
    <MaintenancePanel
      call={call}
      t={(k) => zh[k]}
      enabled
      openSession={open}
      sessionLabel={() => ({ title: '检查发布规则', updatedAt: 1760000000000 })}
    />,
  );
  const row = await screen.findByRole('article', { name: '检查发布规则 · 尚未提交计划' });
  expect(within(row).getByText(zh.maintPlanning)).toBeDefined();
  expect(within(row).queryByRole('button', { name: id })).toBeNull();
  expect(screen.queryByText(zh.maintEmpty)).toBeNull();
  expect(screen.getByText(zh.maintMetrics).closest('details')?.open).toBe(false);
  fireEvent.click(within(row).getByRole('button', { name: zh.openSession }));
  expect(open).toHaveBeenCalledWith(id);
  expect(call.mock.calls.map(([a]) => a.op)).toEqual(['inspect']);
  fireEvent.click(screen.getByRole('button', { name: zh.maintStart }));
  await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  expect(open.mock.calls[1]![0]).not.toBe(id);
});

it('展开概况后，悬停提交核实标题和指标旁的图标会显示各自的说明', async ({ onTestFinished }) => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(
        private notify: (
          entries: { borderBoxSize: { inlineSize: number; blockSize: number }[] }[],
        ) => void,
      ) {}
      observe() {
        this.notify([{ borderBoxSize: [{ inlineSize: 320, blockSize: 40 }] }]);
      }
      disconnect() {}
    },
  );
  onTestFinished(() => {
    vi.unstubAllGlobals();
  });
  render(<MaintenancePanel call={async () => sample()} t={(k) => zh[k]} enabled />);
  fireEvent.click(await screen.findByText(zh.maintMetrics));
  for (const [name, help] of [
    [zh.maintVerification, zh.maintVerificationHelp],
    [zh.maintDifferent, zh.maintDifferentHelp],
    [zh.maintUnknown, zh.maintUnknownHelp],
  ] as const) {
    const icon = screen.getByRole('button', { name: zh.maintHelpLabel.replace('{name}', name) });
    fireEvent.pointerOver(icon, { pointerType: 'mouse' });
    const tip = screen.getByRole('tooltip');
    expect(tip.textContent).toBe(help);
    expect(icon.getAttribute('aria-describedby')).toBe(tip.id);
    fireEvent.pointerOut(icon, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  }
});

it('读取失败不当作空列表，已读且没有记录才显示空状态', async () => {
  const call = vi
    .fn<() => Promise<MaintenanceData>>()
    .mockRejectedValueOnce(new Error())
    .mockResolvedValueOnce({ ...sample(), runs: [] });
  const props = { call, t: (k: keyof typeof zh) => zh[k], enabled: false };
  const view = render(<MaintenancePanel {...props} />);
  await screen.findByRole('alert');
  expect(screen.queryByText(zh.maintEmpty)).toBeNull();
  view.rerender(<MaintenancePanel {...props} refreshKey={1} />);
  await screen.findByText(zh.maintEmpty);
  expect(screen.getByRole('button', { name: zh.maintStart }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(zh.maintDisabled)).toBeDefined();
});

it('放弃只归档选中的未应用记录，可以先取消，失败不隐藏', async () => {
  const data = sample();
  let refuse = true;
  const call = vi.fn(async (a: MaintenanceAction) => {
    if (a.op === 'discard') {
      if (refuse) throw Error('会话运行中');
      return { ...data, runs: [] };
    }
    return data;
  });
  render(<MaintenancePanel call={call} t={(k) => zh[k]} enabled />);
  fireEvent.click(await screen.findByRole('button', { name: zh.maintDiscard }));
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }));
  expect(call.mock.calls.map(([a]) => a.op)).toEqual(['inspect']);
  fireEvent.click(screen.getByRole('button', { name: zh.maintDiscard }));
  fireEvent.click(screen.getByRole('button', { name: zh.maintDiscardConfirm }));
  await screen.findByText(zh.maintDiscardError);
  expect(screen.getByRole('article')).toBeDefined();
  refuse = false;
  fireEvent.click(screen.getByRole('button', { name: zh.maintDiscardConfirm }));
  await screen.findByText(zh.maintEmpty);
  expect(call).toHaveBeenCalledWith({ op: 'discard', id });
});

it('宿主归档和取消归档即时更新列表，不隐藏已应用记录的回滚入口', async () => {
  const applied = id.slice(0, -1) + 'd';
  let ids: readonly string[] = [],
    notify = () => {};
  const archives = {
    getSnapshot: () => ids,
    subscribe: (listen: () => void) => {
      notify = listen;
      return () => {};
    },
  };
  const call = async (): Promise<MaintenanceData> => ({
    ...sample(),
    runs: [
      ...(ids.includes(id) ? [] : [{ id, status: 'planning' as const }]),
      { id: applied, status: 'applied', ...(ids.includes(applied) ? { archived: true } : {}) },
    ],
  });
  render(
    <MaintenancePanel
      call={call}
      t={(k) => zh[k]}
      archives={archives}
      openSession={() => {}}
      enabled
    />,
  );
  await screen.findByText(zh.maintPlanning);
  act(() => {
    ids = [id, applied];
    notify();
  });
  await screen.findByText(zh.maintArchived);
  expect(screen.getAllByRole('article')).toHaveLength(1);
  expect(screen.queryByRole('button', { name: zh.openSession })).toBeNull();
  expect(screen.getByRole('button', { name: zh.maintUndo })).toBeDefined();
  await act(async () => {
    ids = [];
    notify();
  });
  await screen.findByText(zh.maintPlanning);
  expect(screen.getAllByRole('article')).toHaveLength(2);
});

it('选中自动模式不启动整理，启动只授权当前会话，下次仍默认审阅', async () => {
  const call = vi.fn(async (a: MaintenanceAction) => ({
    ...sample(),
    started: a.op === 'start' ? id : null,
  }));
  render(<MaintenancePanel call={call} enabled t={(key) => zh[key]} />);
  await screen.findByRole('article');
  const auto = screen.getByRole<HTMLInputElement>('radio', { name: zh.maintAuto });
  fireEvent.click(auto);
  expect(auto.checked).toBe(true);
  expect(call.mock.calls.map(([a]) => a.op)).toEqual(['inspect']);
  fireEvent.click(screen.getByRole('button', { name: zh.maintStartAuto }));
  await screen.findByRole('button', { name: zh.maintStart });
  expect(auto.checked).toBe(false);
  expect(call).toHaveBeenCalledWith({ op: 'start', mode: 'auto', requestId: expect.any(String) });
});

it('记忆不可用时，切换模式仍解释原因且不发起整理', async () => {
  const call = vi.fn(async () => sample());
  const props = { call, t: (key: keyof typeof zh) => zh[key] };
  const view = render(<MaintenancePanel {...props} enabled={false} />);
  await screen.findByRole('article');
  const auto = screen.getByRole<HTMLInputElement>('radio', { name: zh.maintAuto });
  fireEvent.click(auto);
  const hint = screen.getByText(zh.maintDisabled);
  expect(document.getElementById(auto.getAttribute('aria-describedby')!)?.contains(hint)).toBe(
    true,
  );
  expect(auto.checked).toBe(false);
  view.rerender(<MaintenancePanel {...props} enabled />);
  fireEvent.click(auto);
  expect(auto.checked).toBe(true);
  expect(screen.queryByText(zh.maintModeBlocked)).toBeNull();
  expect(call).toHaveBeenCalledTimes(1);
});
