import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import remote from '../adapters/remote.ts';
import { en, zh } from './locales.ts';
import { MemoryPanel } from './MemoryPanel.tsx';
import type { MemoryPanelProps } from './MemoryPanel.tsx';
import type { PageMutation } from '../page-types.ts';
import { createMemoryCache } from './memory-state.ts';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import { CopyReference, referenceLink } from './CopyReference.tsx';

export const inject = ['remote', 'slots', 'locale', 'sidebarRightTabs'];

function MemorySeat({ identity, ...props }: MemoryPanelProps & { identity: string }) {
  return <MemoryPanel key={identity} identity={identity} {...props} />;
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    stash: { scope: 'workspace' | 'session'; section: 'notes' | 'rules' | 'preferences' };
  }
}

function MemoryTab({
  useTabInfo,
  ...props
}: MemoryPanelProps & { identity: string; useTabInfo: UseSidebarRightTabInfo }) {
  const { tab } = useTabInfo();
  const params = tab.navigation.params;
  const navigation =
    params &&
    'scope' in params &&
    'section' in params &&
    (params.scope === 'workspace' || params.scope === 'session') &&
    (params.section === 'notes' || params.section === 'rules' || params.section === 'preferences')
      ? { scope: params.scope, section: params.section, revision: tab.navigation.revision }
      : undefined;
  return <MemorySeat {...props} navigation={navigation} />;
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(remote);
  const ui = ctx.inject(['remote.stash', 'slots', 'locale', 'sidebarRightTabs'], (scope) => {
    scope.effect(() => scope.locale.register('stash', { en, zh }), 'stash: locale');
    const t = scope.locale.bind('stash');
    scope.slots.inject('conversation.chat.assistant-actions', () =>
      scope.slots.register(
        {
          name: 'conversation.chat.assistant-actions',
          id: 'stash-reference',
          order: 5,
          locale: 'stash',
          inject: (sessionId) => ({
            load: async (messageId: string) => {
              const result = await scope.remote.stash.getReference(sessionId, messageId);
              if (!result.ok) throw result.error;
              return result.value;
            },
          }),
        },
        CopyReference,
      ),
    );
    scope.inject(['contextMenus'], (menus) => {
      menus.effect(
        () =>
          menus.contextMenus.register({
            id: 'stash.copy-session',
            target: 'session',
            order: 460,
            observe: () => [scope.locale],
            resolve: ({ sessionId, displayTitle }) => [
              {
                id: 'copy',
                label: t('copySession'),
                run: () => navigator.clipboard.writeText(referenceLink(sessionId, displayTitle)),
              },
            ],
          }),
        'stash: session reference',
      );
    });
    scope.inject(['contextMenus', 'uiWorkspace', 'sidebarRight'], (menus) => {
      menus.effect(
        () =>
          menus.contextMenus.register({
            id: 'stash.workspace-settings',
            target: 'workspace',
            order: 250,
            observe: () => [scope.locale],
            resolve: ({ workspaceId }) => [
              {
                id: 'settings',
                label: t('settings'),
                run: async () => {
                  await menus.uiWorkspace.openWorkspace(workspaceId);
                  menus.sidebarRight.openTab('stash', {
                    params: { scope: 'workspace', section: 'preferences' },
                  });
                },
              },
            ],
          }),
        'stash: workspace settings',
      );
    });
    scope.effect(
      () =>
        scope.sidebarRightTabs.register({
          id: 'stash',
          kind: 'stash',
          title: () => 'stash',
          guide: [
            { id: 'stash', order: 80, title: () => 'stash', description: () => t('description') },
          ],
        }),
      'stash: tab',
    );
    const listeners = new Set<() => void>();
    const cache = createMemoryCache();
    scope.effect(
      () => () => {
        cache.views.clear();
        cache.drafts.clear();
        cache.navigation.clear();
      },
      'stash: memory drafts',
    );
    const subscribeReset = (listener: () => void) => {
      listeners.add(listener);
      const dispose = scope.on('connection/reset', listener);
      return () => {
        listeners.delete(listener);
        dispose();
      };
    };
    const injectMemory = (id: string) => ({
      identity: id,
      cache,
      openPage: () =>
        scope.sidebarRight?.openTab('stash', {
          params: { scope: 'session', section: 'preferences' },
        }),
      openSession: (sessionId: string) => scope.uiWorkspace?.openSession(sessionId as SessionId),
      load: async () => {
        const result = await scope.remote.stash.getMemory({ kind: 'session', id });
        if (!result.ok) throw result.error;
        return result.value;
      },
      mutate: async (request: PageMutation) => {
        const result = await scope.remote.stash.mutateMemory({ kind: 'session', id }, request);
        if (!result.ok) throw result.error;
        if (result.value.ok) for (const listener of listeners) listener();
        return result.value;
      },
      subscribeReset,
    });
    scope.slots.inject('conversation.input.left', () =>
      scope.slots.register(
        {
          name: 'conversation.input.left',
          id: 'stash-switches',
          order: 80,
          locale: 'stash',
          inject: (id) => ({ ...injectMemory(id), compact: true }),
        },
        MemorySeat,
      ),
    );
    scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: 'stash',
          locale: 'stash',
          inject: injectMemory,
        },
        MemoryTab,
      ),
    );
  });
  try {
    await ui;
  } catch (error) {
    await ui.dispose();
    await unmount();
    throw error;
  }
  return async () => {
    await ui.dispose();
    await unmount();
  };
}
