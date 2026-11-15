// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StatusPanel } from '../src/client/StatusPanel.tsx';
import { en, zh } from '../src/client/locales.ts';
import { CopyReference, referenceLink } from '../src/client/CopyReference.tsx';

afterEach(cleanup);

it('复制完整轮次引用，标题转义与剪贴板失败可见', async () => {
  const writeText = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error('denied'));
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(
    <CopyReference
      messageId="m"
      t={(key) => zh[key]}
      load={async () => ({
        id: 'session-a',
        title: '讨论 [架构]',
        turn: 2,
        from: 3,
        to: 9,
        end: '2026-11-14T23:00:00Z',
      })}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: zh.copyReference }));
  await screen.findByText(zh.copied);
  expect(writeText).toHaveBeenCalledWith(
    '[「讨论 \\[架构\\]」第 2 轮 · 2026-11-14T23:00:00Z](dsh://session/session-a/3..9)',
  );
  fireEvent.click(screen.getByRole('button', { name: zh.copyReference }));
  await screen.findByRole('alert');
  expect(referenceLink('session-a', '标题')).toBe('[标题](dsh://session/session-a)');
});

it('展示连接、版本、失败与重连，卸载时释放订阅', async () => {
  const status = {
    version: '0.3.0',
    hostVersion: '0.2.2-rc.3',
    phase: 3 as const,
    memoryEnabled: true as const,
    trace: 'off' as const,
  };
  const load = vi
    .fn()
    .mockResolvedValueOnce(status)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(status);
  let reset = () => {};
  const dispose = vi.fn();
  const view = render(
    <StatusPanel
      load={load}
      t={(key) => zh[key]}
      subscribeReset={(listener) => {
        reset = listener;
        return dispose;
      }}
    />,
  );
  expect(screen.getByRole('status').textContent).toBe(zh.connecting);
  await screen.findByText('0.3.0');
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }));
  await screen.findByText(zh.disconnected);
  act(() => reset());
  await screen.findByText(zh.connected);
  view.unmount();
  expect(dispose).toHaveBeenCalled();
  expect(Object.keys(en)).toEqual(Object.keys(zh));
});
