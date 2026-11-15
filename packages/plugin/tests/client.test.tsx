// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StatusPanel } from '../src/client/StatusPanel.tsx';
import { en, zh } from '../src/client/locales.ts';

afterEach(cleanup);

it('展示连接、版本、失败与重连，卸载时释放订阅', async () => {
  const status = {
    version: '0.2.1',
    hostVersion: '0.2.2-rc.3',
    phase: 2 as const,
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
  await screen.findByText('0.2.1');
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }));
  await screen.findByText(zh.disconnected);
  act(() => reset());
  await screen.findByText(zh.connected);
  view.unmount();
  expect(dispose).toHaveBeenCalled();
  expect(Object.keys(en)).toEqual(Object.keys(zh));
});
