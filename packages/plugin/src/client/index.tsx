import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import remote from '../adapters/remote.ts';
import { en, zh } from './locales.ts';
import { StatusPanel } from './StatusPanel.tsx';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-context-menu/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import { CopyReference, referenceLink } from './CopyReference.tsx';

export const inject = ['remote', 'slots', 'locale', 'sidebarRightTabs'];

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
    const load = async () => {
      const result = await scope.remote.stash.getStatus();
      if (!result.ok) throw result.error;
      return result.value;
    };
    const subscribeReset = (listener: () => void) => scope.on('connection/reset', listener);
    scope.slots.inject('sidebar.right.pane.tab', () =>
      scope.slots.register(
        {
          name: 'sidebar.right.pane.tab',
          key: 'stash',
          locale: 'stash',
          inject: () => ({ load, subscribeReset }),
        },
        StatusPanel,
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
