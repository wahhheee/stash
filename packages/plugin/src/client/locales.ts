export const en = {
  title: 'stash',
  connecting: 'Connecting…',
  connected: 'Connected to host',
  disconnected: 'Host unavailable',
  version: 'Plugin version',
  host: 'DSH version',
  phase: 'Workspace and session memory, branches, history and references are enabled.',
  refresh: 'Refresh',
  description: 'Plugin status and host connection',
  copyReference: 'Copy turn reference',
  copyReferenceHint:
    'Paste into a conversation so the model can locate and read this turn’s original records.',
  copyPending: 'Preparing turn reference…',
  copySession: 'Copy session reference',
  referenceLabel: '“{title}” turn {turn} · {time}',
  copied: 'Turn reference copied',
  copyFailed: 'Copy failed. Please retry.',
};

export const zh: typeof en = {
  title: 'stash',
  connecting: '连接中…',
  connected: '已连接宿主',
  disconnected: '宿主不可用',
  version: '插件版本',
  host: 'DSH 版本',
  phase: '工作区与会话记忆、分支、原始记录与引用已启用。',
  refresh: '刷新',
  description: '插件状态与宿主连接',
  copyReference: '复制本轮引用',
  copyReferenceHint: '粘贴到对话中，让模型定位并读取这一轮原始记录。',
  copyPending: '正在获取本轮引用…',
  copySession: '复制会话引用',
  referenceLabel: '「{title}」第 {turn} 轮 · {time}',
  copied: '已复制本轮引用',
  copyFailed: '复制失败，请重试。',
};

export type LocaleKey = keyof typeof en;

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    stash: LocaleKey;
  }
}
