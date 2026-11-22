import { Context } from '@deepseek-ai/cordis';
import type { MenuContribution } from '@deepseek-ai/dsh-client-ui-context-menu/client';
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client';
import { expect, it, vi } from 'vitest';
import * as client from '../src/client/index.tsx';
import type { MemoryPanelProps } from '../src/client/MemoryPanel.tsx';
import { zh } from '../src/client/locales.ts';

it('输入框打开会话设置，工作区菜单仅提供该工作区的设置，来源导航可用', async () => {
  const ctx = new Context();
  const seats = new Map<string, { inject: (id: string) => Partial<MemoryPanelProps> }>();
  const openTab = vi.fn();
  const openSession = vi.fn();
  const openWorkspace = vi.fn();
  let workspaceMenu: MenuContribution<'workspace'> | undefined;
  ctx.provide('contextMenus', {
    register: (menu: MenuContribution<'session'> | MenuContribution<'workspace'>) => {
      if (menu.target === 'workspace') workspaceMenu = menu;
      return () => {};
    },
  });
  ctx.provide('remote', { $mount: async () => async () => {}, stash: {} });
  ctx.provide('remote.stash', {});
  ctx.provide('configForms', { get: () => ({}) });
  ctx.provide('workspaces', {
    list: { getSnapshot: () => ({ archivedSessionIds: ['archived'] }), subscribe: () => () => {} },
  });
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: {} }) } });
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: keyof typeof zh) => zh[key],
  });
  ctx.provide('sidebarRightTabs', { register: () => () => {} });
  ctx.provide('sidebarRight', { openTab });
  ctx.provide('uiWorkspace', { openSession, openWorkspace });
  ctx.provide('slots', {
    inject: (_name: string, callback: () => () => void) => callback(),
    register: vi.fn((seat: { name: string; inject: (id: string) => Partial<MemoryPanelProps> }) => {
      seats.set(seat.name, seat);
      return () => seats.delete(seat.name);
    }),
  });
  try {
    await ctx.plugin(client);
    expect(seats.get('settings.section')).toMatchObject({ id: 'stash' });
    const input = seats.get('conversation.input.left')!.inject('current');
    expect(input.compact).toBe(true);
    input.openPage!();
    expect(openTab).toHaveBeenCalledWith('stash', {
      params: { scope: 'session', section: 'preferences' },
    });
    const panel = seats.get('sidebar.right.pane.tab')!.inject('current');
    expect(panel.archives?.getSnapshot()).toEqual(['archived']);
    panel.openSession!('source');
    expect(openSession).toHaveBeenCalledWith('source');
    const workspaceId = 'chosen' as WorkspaceId;
    const actions = await workspaceMenu!.resolve(
      { workspaceId, displayTitle: '工作区', path: '/chosen' },
      new AbortController().signal,
    );
    const settings = actions.find((action) => action.id === 'settings');
    expect(settings).toMatchObject({
      id: 'settings',
      label: zh.settings,
    });
    await settings!.run!();
    expect(openWorkspace).toHaveBeenCalledWith(workspaceId);
    expect(openTab).toHaveBeenLastCalledWith('stash', {
      params: { scope: 'workspace', section: 'preferences' },
    });
  } finally {
    await ctx.fiber.dispose();
  }
});
