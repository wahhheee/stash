// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StatusPanel } from '../src/client/StatusPanel.tsx';
import { en, zh } from '../src/client/locales.ts';
import { CopyReference, referenceLink } from '../src/client/CopyReference.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('引用图标具有明确名称，抑制重复点击并在成功后恢复', async () => {
  vi.useFakeTimers();
  const reference = {
    id: 'session-a',
    title: '测试',
    turn: 1,
    from: 0,
    to: 4,
    end: '2026-11-15T10:00:00Z',
  };
  let resolve!: (value: typeof reference) => void;
  const load = vi.fn(
    () =>
      new Promise<typeof reference>((done) => {
        resolve = done;
      }),
  );
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<CopyReference messageId="m" load={load} t={(key) => zh[key]} />);
  const button = screen.getByRole('button', { name: '复制本轮引用' });
  expect(button.textContent).toBe('');
  expect(button.querySelector('svg')).not.toBeNull();
  fireEvent.click(button);
  fireEvent.click(button);
  expect(load).toHaveBeenCalledTimes(1);
  expect(button.getAttribute('aria-busy')).toBe('true');
  await act(async () => {
    resolve(reference);
  });
  expect(screen.getByRole('status').textContent).toBe(zh.copied);
  expect(writeText).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByRole('status').textContent).toBe('');
  expect(button.getAttribute('aria-busy')).toBe('false');
});

it('组件卸载后不再把迟到的引用写入剪贴板', async () => {
  const reference = {
    id: 'session-a',
    title: '测试',
    turn: 1,
    from: 0,
    to: 4,
    end: '2026-11-15T10:00:00Z',
  };
  let resolve!: (value: typeof reference) => void;
  const writeText = vi.fn();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  const view = render(
    <CopyReference
      messageId="m"
      load={() =>
        new Promise((done) => {
          resolve = done;
        })
      }
      t={(key) => zh[key]}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: zh.copyReference }));
  view.unmount();
  await act(async () => {
    resolve(reference);
  });
  expect(writeText).not.toHaveBeenCalled();
});

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
    version: '0.6.0',
    hostVersion: '0.2.2-rc.3',
    phase: 6 as const,
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
  await screen.findByText('0.6.0');
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }));
  await screen.findByText(zh.disconnected);
  act(() => reset());
  await screen.findByText(zh.connected);
  view.unmount();
  expect(dispose).toHaveBeenCalled();
  expect(Object.keys(en)).toEqual(Object.keys(zh));
});
