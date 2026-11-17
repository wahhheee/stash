import { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import * as client from '../src/client/index.tsx';
import type { MemoryPanelProps } from '../src/client/MemoryPanel.tsx';
import { zh } from '../src/client/locales.ts';

it('输入框入口在真实 Cordis 注入作用域打开会话设置，来源导航使用已声明服务', async () => {
  const ctx = new Context();
  const seats = new Map<string, { inject: (id: string) => Partial<MemoryPanelProps> }>();
  const openTab = vi.fn();
  const openSession = vi.fn();
  ctx.provide('remote', { $mount: async () => async () => {}, stash: {} });
  ctx.provide('remote.stash', {});
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: keyof typeof zh) => zh[key],
  });
  ctx.provide('sidebarRightTabs', { register: () => () => {} });
  ctx.provide('sidebarRight', { openTab });
  ctx.provide('uiWorkspace', { openSession });
  ctx.provide('slots', {
    inject: (_name: string, callback: () => () => void) => callback(),
    register: (seat: { name: string; inject: (id: string) => Partial<MemoryPanelProps> }) => {
      seats.set(seat.name, seat);
      return () => seats.delete(seat.name);
    },
  });
  try {
    await ctx.plugin(client);
    const input = seats.get('conversation.input.left')!.inject('current');
    expect(input.compact).toBe(true);
    input.openPage!();
    expect(openTab).toHaveBeenCalledWith('stash', {
      params: { scope: 'session', section: 'preferences' },
    });
    const panel = seats.get('sidebar.right.pane.tab')!.inject('current');
    panel.openSession!('source');
    expect(openSession).toHaveBeenCalledWith('source');
  } finally {
    await ctx.fiber.dispose();
  }
});
