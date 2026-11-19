// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  DEFAULT_SWITCHES,
  mergeNoteForm,
  projectNote,
  resolveSwitches,
} from '@wahhheee/stash-core';
import { MemoryPanel } from '../src/client/MemoryPanel.tsx';
import type { MemoryPanelProps } from '../src/client/MemoryPanel.tsx';
import { createMemoryCache } from '../src/client/memory-state.ts';
import { notePath } from '../src/client/MemoryLocation.tsx';
import { zh } from '../src/client/locales.ts';
import type {
  MemoryPageData,
  PageFile,
  PageMutation,
  PageMutationResult,
} from '../src/page-types.ts';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const t: MemoryPanelProps['t'] = (key) => zh[key];

const note = (
  path = '/notes/permissions.md',
  description = '记忆页的权限说明 — 只读开关限制模型写入，用户仍可手动编辑。',
): PageFile => {
  const content = mergeNoteForm(null, {
    type: 'fact',
    description,
    body: '## 权限\n\n保留 **手动编辑** 能力。',
    index: true,
    status: null,
    sources: ['[讨论](dsh://session/source/1..4)'],
  });
  return { path, content, revision: 'a'.repeat(64), note: projectNote(content) };
};

function fixture(patch: Partial<MemoryPageData> = {}, props: Partial<MemoryPanelProps> = {}) {
  const data: MemoryPageData = {
    sessionEditable: true,
    workspaceId: 'w',
    title: '工程',
    sessionId: 's',
    sessionTitle: '设计讨论',
    globalEnabled: true,
    workspace: DEFAULT_SWITCHES,
    session: DEFAULT_SWITCHES,
    effective: resolveSwitches(true),
    files: {
      workspace: [{ path: '/RULES.md', content: '旧规则', revision: 'a'.repeat(64) }],
      session: [],
    },
    revisions: { workspace: 'b'.repeat(64), session: 'c'.repeat(64) },
    ...patch,
  };
  const load = vi.fn(async () => structuredClone(data));
  let revision = 1;
  const mutate = vi.fn(async ({ action }: PageMutation): Promise<PageMutationResult> => {
    const scope = action.op === 'promote' ? 'workspace' : action.scope;
    let file: PageFile | null = null;
    if (action.op === 'note') {
      const old = data.files[scope].find((row) => row.path === action.path);
      const content = mergeNoteForm(old?.content ?? null, action.value);
      file = {
        path: action.path,
        content,
        revision: String(revision++).repeat(64),
        note: projectNote(content),
      };
    } else if (action.op === 'save' && action.content !== null)
      file = {
        path: action.path,
        content: action.content,
        revision: String(revision++).repeat(64),
      };
    else if (action.op === 'promote')
      file = {
        ...data.files.session.find((row) => row.path === action.path)!,
        path: action.destination,
      };
    if (action.op === 'switches') {
      data[scope] = action.value;
      data.effective = resolveSwitches(data.globalEnabled, data.workspace, data.session);
    } else {
      data.files[scope] =
        action.op === 'clear'
          ? []
          : data.files[scope].filter(
              (row) => row.path !== (file?.path ?? ('path' in action ? action.path : '')),
            );
      if (file) data.files[scope].push(file);
    }
    return { ok: true, scope, file, cleared: action.op === 'clear' };
  });
  let listener = () => {};
  const input: MemoryPanelProps = {
    t,
    load,
    mutate,
    subscribeReset: (callback) => {
      listener = callback;
      return () => {};
    },
    ...props,
  };
  const view = render(<MemoryPanel {...input} />);
  return { data, load, mutate, view, input, reset: () => listener() };
}

async function ready() {
  await screen.findByRole('button', { name: zh.scopePicker });
}

function choose(label: string, item: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
  fireEvent.click(screen.getByRole('menuitem', { name: item }));
}

function tab(name: string) {
  fireEvent.click(screen.getByRole('tab', { name }));
}

function input(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function newDraft() {
  await ready();
  fireEvent.click(screen.getByRole('button', { name: zh.newNote }));
  input(zh.noteDescription, '保存策略 — 只读限制模型写入，用户仍能编辑。');
  input(zh.content, '# 保存说明\n\n这是正文。');
}

it('默认会话列表，新建只开启表单；字段校验后创建并展示正文，返回可见计数与笔记', async () => {
  const { mutate } = fixture();
  await ready();
  expect(screen.getByRole('button', { name: zh.scopePicker }).textContent).toContain(
    '本会话 · 设计讨论',
  );
  expect(screen.getByText('0 篇笔记')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: zh.newNote }));
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  expect(screen.getByText(zh.requiredDescription)).toBeDefined();
  expect(mutate).not.toHaveBeenCalled();
  input(zh.noteDescription, '记忆页的权限说明 — 用户始终可以手动编辑。');
  input(zh.content, '**保存成功**');
  fireEvent.click(screen.getByRole('button', { name: zh.addSource }));
  input(zh.sourceName + ' 1', '讨论记录');
  expect((screen.getByLabelText(zh.sourceName + ' 1') as HTMLInputElement).value).toBe('讨论记录');
  input(zh.sourceTarget + ' 1', 'dsh://session/source/1..4');
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  await screen.findByText(zh.created);
  expect(screen.getByText('保存成功').tagName).toBe('STRONG');
  expect(screen.queryByRole('textbox', { name: zh.content })).toBeNull();
  expect(mutate.mock.calls[0]![0].action).toMatchObject({
    op: 'note',
    scope: 'session',
    path: '/notes/note.md',
    expected: null,
    value: { type: 'fact', sources: ['[讨论记录](dsh://session/source/1..4)'] },
  });
  fireEvent.click(screen.getByRole('button', { name: zh.back }));
  expect(screen.getByText('1 篇笔记')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: /记忆页的权限说明/u }));
  expect(screen.getByText('保存成功')).toBeDefined();
});

it('目录选择、草稿子目录和直接路径互通，自动补全扩展名且阻止跨范围与重名', async () => {
  const { mutate } = fixture({ files: { workspace: [], session: [note('/notes/dev/build.md')] } });
  await newDraft();
  choose(zh.chooseFolder, '笔记 / dev');
  fireEvent.click(screen.getByRole('button', { name: zh.newFolder }));
  input(zh.folderName, 'ui');
  fireEvent.click(screen.getByRole('button', { name: zh.addFolder }));
  input(zh.fileName, 'flow');
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: zh.manualPath }));
  expect((screen.getByLabelText(zh.path) as HTMLInputElement).value).toBe('dev/ui/flow');
  input(zh.path, '/notes/workspace.md');
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  expect(screen.getByText(zh.invalidPath)).toBeDefined();
  input(zh.path, './notes/dev/build.md');
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  expect(screen.getByText(zh.exists)).toBeDefined();
  input(zh.path, './notes/dev/ui/flow');
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  await screen.findByText(zh.created);
  expect(mutate.mock.calls[0]![0].action).toMatchObject({ path: '/notes/dev/ui/flow.md' });
});

it('范围对笔记、规则和设置一致；全局关闭仍可编辑工作区规则', async () => {
  const { mutate } = fixture({ globalEnabled: false, effective: resolveSwitches(false) });
  await ready();
  choose(zh.scopePicker, '工作区 · 工程');
  tab(zh.preferences);
  expect((screen.getByRole('button', { name: zh.enabled }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  expect(screen.getByText(zh.globalOff)).toBeDefined();
  tab(zh.rules);
  expect(screen.getByText('旧规则')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: zh.editRules }));
  input(zh.content, '用户新规则');
  fireEvent.click(screen.getByRole('button', { name: zh.saveRules }));
  await screen.findByText(zh.saved);
  expect(mutate.mock.calls[0]![0].action).toEqual({
    op: 'save',
    scope: 'workspace',
    path: '/RULES.md',
    expected: 'a'.repeat(64),
    content: '用户新规则',
  });
});

it('设置即时保存，失效原因明确且不出现笔记保存按钮', async () => {
  const { mutate } = fixture();
  await ready();
  tab(zh.preferences);
  choose(zh.enabled, zh.off);
  await screen.findByText(zh.saved);
  expect(mutate.mock.calls[0]![0].action).toMatchObject({
    op: 'switches',
    scope: 'session',
    value: { enabled: false },
  });
  fireEvent.click(screen.getByRole('switch', { name: zh.discoverable }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
  expect(mutate.mock.calls[1]![0].action).toMatchObject({
    value: { enabled: false, discoverable: false },
  });
  expect(screen.queryByRole('button', { name: zh.saveChanges })).toBeNull();
});

it('内部导航提供继续编辑、放弃和保存并继续；保存到原范围后才切换', async () => {
  const { mutate } = fixture();
  await newDraft();
  choose(zh.scopePicker, '工作区 · 工程');
  expect(screen.getByRole('dialog', { name: zh.leaveTitle })).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: zh.keepEditing }));
  expect((screen.getByLabelText(zh.content) as HTMLTextAreaElement).value).toContain('正文');
  choose(zh.scopePicker, '工作区 · 工程');
  fireEvent.click(screen.getByRole('button', { name: zh.saveAndContinue }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: zh.scopePicker }).textContent).toContain(
      '工作区 · 工程',
    ),
  );
  expect(mutate.mock.calls[0]![0].action).toMatchObject({ scope: 'session' });
  expect(screen.getByText('0 篇笔记')).toBeDefined();
});

it('断线重试复用请求标识，抑制重复点击，成功后刷新失败仍显示已保存内容', async () => {
  const { mutate, load } = fixture();
  await newDraft();
  mutate.mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  await screen.findByText(zh.connectionError);
  expect((screen.getByLabelText(zh.content) as HTMLTextAreaElement).value).toContain('正文');
  load.mockRejectedValueOnce(new Error('refresh offline'));
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  fireEvent.click(screen.getByRole('button', { name: zh.createNote }));
  await screen.findByText(zh.savedRefreshFailed);
  expect(mutate).toHaveBeenCalledTimes(2);
  expect(mutate.mock.calls[0]![0].id).toBe(mutate.mock.calls[1]![0].id);
  expect(screen.getByText('这是正文。')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: zh.retry }));
  await waitFor(() => expect(screen.queryByText(zh.savedRefreshFailed)).toBeNull());
});

it('版本冲突展示最新内容，明确保留草稿后以新版本保存；重连不丢稿', async () => {
  const file = note();
  const { mutate, data, reset, load } = fixture({ files: { workspace: [], session: [file] } });
  await ready();
  fireEvent.click(screen.getByRole('button', { name: /记忆页的权限说明/u }));
  fireEvent.click(screen.getByRole('button', { name: zh.edit }));
  input(zh.content, '我的草稿');
  data.files.session[0] = { ...note(file.path, '外部更新后的描述'), revision: 'f'.repeat(64) };
  mutate.mockResolvedValueOnce({ ok: false, code: 'STASH_STALE_READ' });
  fireEvent.click(screen.getByRole('button', { name: zh.saveChanges }));
  await screen.findByText(zh.conflict);
  act(reset);
  await waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  expect((screen.getByLabelText(zh.content) as HTMLTextAreaElement).value).toBe('我的草稿');
  fireEvent.click(screen.getByRole('button', { name: zh.latest }));
  const dialog = await screen.findByRole('dialog', { name: zh.compareTitle });
  expect(within(dialog).getByText('外部更新后的描述')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: zh.mergeLatest }));
  fireEvent.click(screen.getByRole('button', { name: zh.saveChanges }));
  await screen.findByText(zh.saved);
  expect(mutate.mock.calls[1]![0].action).toMatchObject({
    expected: 'f'.repeat(64),
    value: { body: '我的草稿' },
  });
});

it('外部切换会话后恢复草稿，未开始会话提前禁用创建但开关仍可使用', async () => {
  const cache = createMemoryCache();
  const first = fixture({}, { cache, identity: 's' });
  await newDraft();
  first.view.unmount();
  const second = fixture(
    { sessionId: 'other', sessionEditable: false },
    { cache, identity: 'other' },
  );
  await ready();
  expect(screen.getByText(zh.sessionNotStarted)).toBeDefined();
  expect((screen.getByRole('button', { name: zh.newNote }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  tab(zh.preferences);
  expect((screen.getByRole('button', { name: zh.enabled }) as HTMLButtonElement).disabled).toBe(
    false,
  );
  second.view.unmount();
  fixture({}, { cache, identity: 's' });
  await screen.findByText(zh.restoredDraft);
  expect((screen.getByLabelText(zh.content) as HTMLTextAreaElement).value).toContain('正文');
});

it('来源可打开会话或复制，编辑既有笔记不提供路径改名，复制与删除明确区分', async () => {
  const file = note();
  const openSession = vi.fn();
  const { mutate, data } = fixture({ files: { workspace: [], session: [file] } }, { openSession });
  await ready();
  fireEvent.click(screen.getByRole('button', { name: /记忆页的权限说明/u }));
  fireEvent.click(screen.getByRole('button', { name: zh.openSession }));
  expect(openSession).toHaveBeenCalledWith('source');
  fireEvent.click(screen.getByRole('button', { name: zh.edit }));
  expect(screen.queryByLabelText(zh.fileName)).toBeNull();
  expect(screen.getByText('./notes/permissions.md')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: zh.cancel }));
  choose(zh.more, zh.copyToWorkspace);
  input(zh.fileName, 'workspace-copy');
  fireEvent.click(screen.getByRole('button', { name: zh.copyNote }));
  await screen.findByText(zh.copiedNote);
  expect(data.files.session).toHaveLength(1);
  expect(mutate.mock.calls[0]![0].action).toMatchObject({
    op: 'promote',
    destination: '/notes/workspace-copy.md',
  });
  fireEvent.click(screen.getByRole('button', { name: zh.viewCopy }));
  choose(zh.more, zh.delete);
  const dialog = screen.getByRole('dialog', { name: zh.deleteNoteTitle });
  fireEvent.click(within(dialog).getByRole('button', { name: zh.delete }));
  await screen.findByText(zh.deleted);
  expect(data.files.workspace).toHaveLength(0);
  expect(data.files.session).toHaveLength(1);
});

it('工作区入口直达正确设置，清空需要确认且发送加载时的范围版本', async () => {
  const { mutate } = fixture(
    {},
    { navigation: { scope: 'workspace', section: 'preferences', revision: 1 } },
  );
  await ready();
  expect(screen.getByRole('tab', { name: zh.preferences }).getAttribute('aria-selected')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: zh.clearWorkspace }));
  expect(screen.getByRole('dialog').textContent).toContain('原始对话');
  expect(mutate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: zh.confirm }));
  await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
  expect(mutate.mock.calls[0]![0].action).toEqual({
    op: 'clear',
    scope: 'workspace',
    expected: 'b'.repeat(64),
    confirm: true,
  });
});

it('路径保持范围语义，拒绝系统路径与遍历', () => {
  expect(notePath('dev/build', 'workspace')).toBe('/notes/dev/build.md');
  expect(notePath('./notes/dev/build.md', 'session')).toBe('/notes/dev/build.md');
  for (const value of ['../bad', 'C:\\temp\\note', 'a/../note', 'CON', '/RULES.md', ''])
    expect(() => notePath(value, 'workspace')).toThrow();
  expect(() => notePath('./notes/a', 'workspace')).toThrow();
  expect(() => notePath('/notes/a', 'session')).toThrow();
});

it('已处理过的入口参数不覆盖重新打开页面时保留的草稿', async () => {
  const cache = createMemoryCache();
  const navigation = { scope: 'workspace' as const, section: 'preferences' as const, revision: 1 };
  const first = fixture({}, { cache, identity: 's', navigation });
  await ready();
  tab(zh.notes);
  fireEvent.click(screen.getByRole('button', { name: zh.newNote }));
  input(zh.noteDescription, '恢复草稿 — 重新打开侧栏仍保留输入。');
  first.view.unmount();
  fixture({}, { cache, identity: 's', navigation });
  await screen.findByText(zh.restoredDraft);
  expect((screen.getByLabelText(zh.noteDescription) as HTMLTextAreaElement).value).toContain(
    '恢复草稿',
  );
});

function quickMenu() {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}

      unobserve() {}

      disconnect() {}
    },
  );
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })),
  );
  fireEvent.click(screen.getByRole('button', { name: 'stash · 记忆' }));
}

it('快捷菜单仅在读取失败时显示重试，重试成功或自动恢复后移除入口', async () => {
  const { data, load, mutate, reset } = fixture({}, { compact: true });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'stash · 记忆' }).textContent).toContain('开'),
  );
  quickMenu();
  expect(screen.queryByRole('menuitem', { name: zh.refreshMemory })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: zh.retry })).toBeNull();
  fireEvent.click(screen.getByRole('menuitem', { name: zh.discoverable }));
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.saved));
  expect(mutate).toHaveBeenCalledOnce();
  expect(load).toHaveBeenCalledTimes(2);
  expect(data.session.discoverable).toBe(false);
  load.mockRejectedValueOnce(new Error('offline'));
  act(reset);
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.loadFailed));
  let finish!: (value: MemoryPageData) => void;
  load.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const retry = screen.getByRole('menuitem', { name: zh.retry });
  fireEvent.click(retry);
  expect(screen.getByRole('status').textContent).toBe(zh.loadingMemory);
  expect((retry as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(retry);
  expect(load).toHaveBeenCalledTimes(4);
  await act(async () => finish({ ...data, effective: { ...data.effective, enabled: false } }));
  expect(screen.getByRole('status').textContent).toBe('');
  expect(screen.queryByRole('menuitem', { name: zh.retry })).toBeNull();
  expect(screen.getByRole('button', { name: 'stash · 记忆' }).textContent).toContain('关');
  load.mockRejectedValueOnce(new Error('offline'));
  act(reset);
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.loadFailed));
  expect(screen.getByRole('menuitem', { name: zh.retry })).toBeDefined();
  act(reset);
  await waitFor(() => expect(screen.queryByRole('menuitem', { name: zh.retry })).toBeNull());
  expect(screen.getByRole('button', { name: 'stash · 记忆' }).textContent).toContain('开');
});

it('快捷设置打开失败时保留菜单并显示反馈，重试成功才关闭', async () => {
  const openPage = vi.fn().mockImplementationOnce(() => {
    throw new Error('unavailable');
  });
  fixture({}, { compact: true, openPage });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'stash · 记忆' }).textContent).toContain('开'),
  );
  quickMenu();
  const open = screen.getByRole('menuitem', { name: zh.memory + ' · ' + zh.preferences });
  fireEvent.click(open);
  expect(screen.getByRole('status').textContent).toBe(zh.openMemoryFailed);
  expect(screen.queryByRole('menuitem', { name: zh.retry })).toBeNull();
  expect(screen.getByRole('button', { name: 'stash · 记忆' }).getAttribute('aria-expanded')).toBe(
    'true',
  );
  fireEvent.click(open);
  expect(openPage).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'stash · 记忆' }).getAttribute('aria-expanded')).toBe(
    'false',
  );
});

it('只有工作区有整理页；设置不加载整理；回到会话范围选中笔记', async () => {
  const maintenance = vi.fn(async () => {
    throw new Error('测试读取失败');
  });
  fixture({}, { maintenance });
  await ready();
  expect(screen.queryByRole('tab', { name: zh.maintTab })).toBeNull();
  choose(zh.scopePicker, '工作区 · 工程');
  tab(zh.preferences);
  expect(screen.getByRole('region', { name: zh.switchSettings })).toBeDefined();
  expect(maintenance).not.toHaveBeenCalled();
  tab(zh.maintTab);
  await screen.findByText(zh.maintInspectError);
  expect(screen.queryByText(zh.changesImmediate)).toBeNull();
  choose(zh.scopePicker, zh.currentSession + ' · 设计讨论');
  expect(screen.queryByRole('tab', { name: zh.maintTab })).toBeNull();
  expect(screen.getByRole('tab', { name: zh.notes }).getAttribute('aria-selected')).toBe('true');
});
