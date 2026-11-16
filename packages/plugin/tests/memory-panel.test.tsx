// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SWITCHES } from '@wahhheee/stash-core';
import { MemoryPanel } from '../src/client/MemoryPanel.tsx';
import { zh } from '../src/client/locales.ts';
import type { MemoryPageData } from '../src/page-types.ts';

afterEach(cleanup);

function fixture(globalEnabled = true) {
  const data: MemoryPageData = {
    sessionEditable: true,
    workspaceId: 'w',
    title: '工程',
    sessionId: 's',
    globalEnabled,
    workspace: DEFAULT_SWITCHES,
    session: DEFAULT_SWITCHES,
    effective: {
      enabled: globalEnabled,
      writable: globalEnabled,
      discoverable: true,
      inheritWorkspace: true,
      source: 'global',
    },
    files: {
      workspace: [{ path: '/RULES.md', content: '旧规则', revision: 'a'.repeat(64) }],
      session: [],
    },
    revisions: { workspace: 'b'.repeat(64), session: 'c'.repeat(64) },
  };
  const load = vi.fn().mockResolvedValue(data);
  const change = vi.fn().mockResolvedValue(data);
  let listener = () => {};
  const view = render(
    <MemoryPanel
      t={(key) => zh[key]}
      load={load}
      change={change}
      subscribeReset={(callback) => {
        listener = callback;
        return () => {};
      }}
    />,
  );
  return { data, load, change, view, reset: () => listener() };
}

it('三级开关展示继承与来源，全局关闭禁用下级但允许用户编辑', async () => {
  const { change } = fixture(false);
  await screen.findByText('工程');
  expect(
    (screen.getByLabelText(zh.workspace + ' ' + zh.enabled) as HTMLSelectElement).closest(
      'fieldset',
    )?.disabled,
  ).toBe(true);
  expect(screen.getByText(zh.globalOff)).toBeDefined();
  fireEvent.change(screen.getByLabelText(zh.content), { target: { value: '用户新规则' } });
  fireEvent.click(screen.getByRole('button', { name: zh.save }));
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith({
      op: 'save',
      scope: 'workspace',
      path: '/RULES.md',
      content: '用户新规则',
      expected: 'a'.repeat(64),
    }),
  );
});

it('切换三态和两态发送明确范围，写权限不阻止界面编辑', async () => {
  const { change } = fixture();
  await screen.findByText('工程');
  fireEvent.change(screen.getByLabelText(zh.session + ' ' + zh.enabled), {
    target: { value: 'false' },
  });
  await waitFor(() =>
    expect(change).toHaveBeenCalledWith({
      op: 'switches',
      scope: 'session',
      value: { ...DEFAULT_SWITCHES, enabled: false },
    }),
  );
  await waitFor(() =>
    expect((screen.getByLabelText(zh.discoverable) as HTMLInputElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByLabelText(zh.discoverable));
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith({
      op: 'switches',
      scope: 'session',
      value: { ...DEFAULT_SWITCHES, discoverable: false },
    }),
  );
});

it('草稿切换范围需确认，确认后仍选中用户最初选择的范围', async () => {
  fixture();
  await screen.findByText('工程');
  fireEvent.change(screen.getByLabelText(zh.content), { target: { value: '工作区草稿' } });
  fireEvent.change(screen.getByLabelText(zh.scope), { target: { value: 'session' } });
  expect(screen.getByRole('alertdialog').textContent).toContain(zh.discardDraft);
  expect((screen.getByLabelText(zh.scope) as HTMLSelectElement).value).toBe('workspace');
  fireEvent.click(screen.getByRole('button', { name: zh.confirm }));
  expect((screen.getByLabelText(zh.scope) as HTMLSelectElement).value).toBe('session');
  expect((screen.getByLabelText(zh.content) as HTMLTextAreaElement).value).toBe('');
});

it('失败和重连保留草稿，刷新需确认；清空包含范围说明和加载时版本', async () => {
  const { change, reset, load } = fixture();
  await screen.findByText('工程');
  change.mockRejectedValueOnce(new Error('STASH_STALE_READ'));
  fireEvent.change(screen.getByLabelText(zh.content), { target: { value: '未保存草稿' } });
  fireEvent.click(screen.getByRole('button', { name: zh.save }));
  await screen.findByRole('alert');
  expect((screen.getByLabelText(zh.content) as HTMLTextAreaElement).value).toBe('未保存草稿');
  act(reset);
  expect(load).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }));
  expect(screen.getByRole('alertdialog').textContent).toContain(zh.discardDraft);
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }));
  fireEvent.click(screen.getByRole('button', { name: zh.clearWorkspace }));
  expect(screen.getByRole('alertdialog').textContent).toContain('原始对话');
  expect(change).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: zh.confirm }));
  await waitFor(() =>
    expect(change).toHaveBeenLastCalledWith({
      op: 'clear',
      scope: 'workspace',
      expected: 'b'.repeat(64),
      confirm: true,
    }),
  );
});
