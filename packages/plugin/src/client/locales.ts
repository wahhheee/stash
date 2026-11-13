export const en = {
  title: 'stash',
  connecting: 'Connecting…',
  connected: 'Connected to host',
  disconnected: 'Host unavailable',
  version: 'Plugin version',
  host: 'DSH version',
  phase: 'Workspace memory and resident context are enabled.',
  refresh: 'Refresh',
  description: 'Plugin status and host connection',
};

export const zh: typeof en = {
  title: 'stash',
  connecting: '连接中…',
  connected: '已连接宿主',
  disconnected: '宿主不可用',
  version: '插件版本',
  host: 'DSH 版本',
  phase: '工作区记忆与常驻上下文已启用。',
  refresh: '刷新',
  description: '插件状态与宿主连接',
};

export type LocaleKey = keyof typeof en;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    stash: LocaleKey;
  }
}
