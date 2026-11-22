import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { resolveSwitches } from '@wahhheee/stash-core';
import {
  Menu,
  randomUuid,
  IconChevronLeftOutlineRegular,
  IconPlusOutlineRegular,
  IconEllipsisOutlineRegular,
} from './dsh-ui.ts';
import type {
  MemoryPageData,
  PageEdit,
  PageFile,
  PageMutation,
  PageMutationResult,
} from '../page-types.ts';
import { Button, Choice, Markdown, Modal, SegmentedTabs } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import { MemoryLocation, displayPath, notePath } from './MemoryLocation.tsx';
import { NoteEditor } from './NoteEditor.tsx';
import { NoteBadges, NoteContent } from './NoteContent.tsx';
import { MaintenancePanel } from './MaintenancePanel.tsx';
import type { MaintenanceCall, ArchiveSource } from './MaintenancePanel.tsx';
import { MemorySettings, QuickMemory } from './MemorySettings.tsx';
import {
  createMemoryCache,
  draftKey,
  mutationMessage,
  nextNotePath,
  splitSource,
} from './memory-state.ts';
import type {
  MemoryCache,
  MemoryDraft,
  MemoryScope,
  MemorySection,
  MemoryView,
} from './memory-state.ts';
import styles from './MemoryPanel.module.css';

export interface MemoryPanelProps {
  t: Translate;
  load: () => Promise<MemoryPageData>;
  mutate: (request: PageMutation) => Promise<PageMutationResult>;
  subscribeReset: (listener: () => void) => () => void;
  identity?: string;
  cache?: MemoryCache;
  navigation?: { scope: MemoryScope; section: MemorySection; revision: number } | undefined;
  openPage?: (() => void) | undefined;
  openSession?: ((id: string) => void) | undefined;
  maintenance?: MaintenanceCall;
  archives?: ArchiveSource;
  activity?: { subscribe: (listener: () => void) => () => void; getSnapshot: () => string };
  sessionLabel?: (id: string) => { title?: string; updatedAt: number } | undefined;
  compact?: boolean;
}

interface Issue {
  message: string;
  code?: string;
  channel: string;
}

export function MemoryPanel({
  t,
  load,
  mutate,
  subscribeReset,
  identity = 'memory',
  cache: providedCache,
  navigation,
  openPage,
  openSession,
  maintenance,
  archives,
  activity,
  sessionLabel,
  compact = false,
}: MemoryPanelProps): ReactNode {
  const localCache = useRef(createMemoryCache());
  const cache = providedCache ?? localCache.current;
  const initialNavigation = useRef(
    navigation && cache.navigation.get(identity) !== navigation.revision ? navigation : undefined,
  );
  const [view, setView] = useState<MemoryView>(() =>
    initialNavigation.current
      ? { ...initialNavigation.current, path: null }
      : (cache.views.get(identity) ?? { scope: 'session', section: 'notes', path: null }),
  );
  const { scope, section, path } = view;
  const [data, setData] = useState<MemoryPageData>();
  const [draft, setDraft] = useState<MemoryDraft | null>(null);
  const [healthRefresh, setHealthRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState('');
  const [issue, setIssue] = useState<Issue | null>(null);
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [leave, setLeave] = useState<{ run: () => void } | null>(null);
  const [confirm, setConfirm] = useState<'delete' | 'clear' | null>(null);
  const [copy, setCopy] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ file: PageFile | null } | null>(null);
  const [more, setMore] = useState(false);
  const live = useRef(true);
  const initialized = useRef(false);
  const busy = useRef(false);
  const generation = useRef(0);
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const current = useRef({ data, view, draft });
  current.current = { data, view, draft };
  const tabId = useId();
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const field = scroll.current?.querySelector<HTMLElement>('[data-invalid="true"]');
    if (!field) return;
    field.scrollIntoView?.({ block: 'nearest' });
    field.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true });
  }, [errors]);
  const putView = (next: MemoryView) => {
    if (scroll.current) scroll.current.scrollTop = 0;
    cache.views.set(identity, next);
    setView(next);
  };
  const putDraft = (next: MemoryDraft | null) => {
    if (data) {
      const key = draftKey(data, scope);
      if (next) cache.drafts.set(key, next);
      else cache.drafts.delete(key);
    }
    setDraft(next);
  };
  const refresh = useCallback(
    async (saved = false, feedback = false) => {
      const token = ++generation.current;
      setLoading(true);
      if (feedback) {
        setNotice('');
        setHealthRefresh((n) => n + 1);
      }
      try {
        const value = await load();
        if (!live.current || token !== generation.current) return;
        setData(value);
        setIssue((old) => (old?.channel === 'load' ? null : old));
        if (current.current.draft?.dirty && !saved) setNotice(t('latestAvailable'));
        else if (feedback) setNotice(t('refreshedMemory'));
      } catch {
        if (live.current && token === generation.current)
          setIssue({ channel: 'load', message: t(saved ? 'savedRefreshFailed' : 'loadFailed') });
      } finally {
        if (live.current && token === generation.current) setLoading(false);
      }
    },
    [load, t],
  );
  useEffect(() => {
    live.current = true;
    void refresh();
    return () => {
      live.current = false;
      generation.current++;
    };
  }, [refresh]);
  useEffect(
    () =>
      subscribeReset(() => {
        if (!busy.current) void refresh();
      }),
    [subscribeReset, refresh],
  );
  useEffect(() => {
    if (!data || initialized.current || compact) return;
    initialized.current = true;
    const next = { ...current.current.view };
    if (!data.sessionId) next.scope = 'workspace';
    const restored = cache.drafts.get(draftKey(data, next.scope));
    if (restored && !initialNavigation.current) {
      next.section = restored.kind === 'note' ? 'notes' : 'rules';
      next.path = restored.expected === null ? null : restored.path;
      setDraft(restored);
      setNotice(t('restoredDraft'));
    }
    cache.views.set(identity, next);
    if (navigation) cache.navigation.set(identity, navigation.revision);
    setView(next);
  }, [data, cache, identity, navigation, compact, t]);

  const resetFeedback = () => {
    setIssue(null);
    setNotice('');
    setErrors({});
    setCopiedPath(null);
  };
  const go = (next: MemoryView) => {
    resetFeedback();
    putView(next);
    const restored = data ? cache.drafts.get(draftKey(data, next.scope)) : undefined;
    if (restored && (restored.kind === 'note' ? 'notes' : 'rules') === next.section) {
      setDraft(restored);
      putView({ ...next, path: restored.expected === null ? null : restored.path });
      setNotice(t('restoredDraft'));
    } else setDraft(null);
  };
  const guard = (run: () => void) => {
    if (busy.current) return;
    if (draft?.dirty) setLeave({ run });
    else {
      if (draft) putDraft(null);
      run();
    }
  };
  const navigateRef = useRef((next: MemoryView) => go(next));
  navigateRef.current = (next) => guard(() => go(next));
  const navigationRevision = useRef(navigation?.revision);
  useEffect(() => {
    if (!navigation || navigationRevision.current === navigation.revision) return;
    navigationRevision.current = navigation.revision;
    cache.navigation.set(identity, navigation.revision);
    navigateRef.current({ scope: navigation.scope, section: navigation.section, path: null });
  }, [navigation, cache, identity]);

  const runMutation = async (action: PageEdit, channel: string) => {
    if (busy.current) return null;
    busy.current = true;
    generation.current++;
    setLoading(false);
    setPending(channel);
    setIssue(null);
    setNotice('');
    try {
      const fingerprint = JSON.stringify(action);
      if (request.current?.fingerprint !== fingerprint)
        request.current = { fingerprint, id: randomUuid() };
      const result = await mutate({ id: request.current.id, action });
      if (!result.ok) {
        if (live.current) {
          const message = mutationMessage(result, t);
          setIssue({ message, code: result.code, channel });
          if (result.field) setErrors({ [result.field]: message });
        }
        return null;
      }
      request.current = null;
      if (live.current)
        setData((old) => {
          if (!old) return old;
          if (action.op === 'switches') {
            const updated = { ...old, [action.scope]: action.value };
            return {
              ...updated,
              effective: resolveSwitches(updated.globalEnabled, updated.workspace, updated.session),
            };
          }
          const files = result.cleared
            ? []
            : old.files[result.scope].filter(
                (file) =>
                  file.path !== (result.file?.path ?? ('path' in action ? action.path : '')),
              );
          if (result.file) files.push(result.file);
          return {
            ...old,
            files: {
              ...old.files,
              [result.scope]: files.sort((a, b) => a.path.localeCompare(b.path)),
            },
          };
        });
      return result;
    } catch {
      if (live.current) setIssue({ message: t('connectionError'), channel });
      return null;
    } finally {
      busy.current = false;
      if (live.current) setPending('');
    }
  };
  const saveDraft = async (): Promise<boolean> => {
    if (!draft || !data) return false;
    const fields: Record<string, string> = {};
    let destination = draft.path;
    if (draft.kind === 'note') {
      if (!draft.value.type.trim()) fields.type = t('requiredType');
      else if (/[\r\n]/u.test(draft.value.type)) fields.type = t('singleLine');
      if (!draft.value.description.trim()) fields.description = t('requiredDescription');
      else if (/[\r\n]/u.test(draft.value.description)) fields.description = t('singleLine');
      if (draft.value.sources?.some((source) => !splitSource(source).target.trim()))
        fields.sources = t('sourceTarget');
      if (draft.expected === null) {
        try {
          destination = notePath(draft.path, scope);
        } catch {
          fields.path = t('invalidPath');
        }
        if (data.files[scope].some((file) => file.path === destination)) fields.path = t('exists');
      }
    }
    setErrors(fields);
    if (Object.keys(fields).length) {
      setIssue({ channel: 'edit', message: t('invalidData') });
      return false;
    }
    const key = draftKey(data, scope);
    const result = await runMutation(
      draft.kind === 'note'
        ? { op: 'note', scope, path: destination, expected: draft.expected, value: draft.value }
        : {
            op: 'save',
            scope,
            path: '/RULES.md',
            expected: draft.expected,
            content: draft.content,
          },
      'edit',
    );
    if (!result) return false;
    // 切换宿主会话后，迟到回执只清除它所保存的草稿，不影响新会话的编辑。
    if (cache.drafts.get(key) === draft) cache.drafts.delete(key);
    if (live.current) {
      setDraft(null);
      putView({ ...view, path: result.file?.path ?? null });
      setErrors({});
      setNotice(t(draft.expected === null && draft.kind === 'note' ? 'created' : 'saved'));
      void refresh(true);
    }
    return true;
  };
  const updateSettings = async (value: MemoryPageData['session'], level = scope) => {
    if (await runMutation({ op: 'switches', scope: level, value }, 'settings')) {
      if (live.current) {
        setNotice(t('saved'));
        void refresh(true);
      }
    }
  };
  const loadLatest = async () => {
    if (!draft) return;
    setLoading(true);
    try {
      const value = await load();
      if (!live.current) return;
      setData(value);
      setCompare({ file: value.files[scope].find((file) => file.path === draft.path) ?? null });
    } catch {
      if (live.current) setIssue({ message: t('loadFailed'), channel: 'edit' });
    } finally {
      if (live.current) setLoading(false);
    }
  };
  const edit = (file: PageFile | undefined, kind: 'note' | 'rules') => {
    resetFeedback();
    if (kind === 'rules')
      putDraft({
        kind,
        path: '/RULES.md',
        content: file?.content ?? '',
        expected: file?.revision ?? null,
        dirty: false,
      });
    else if (file?.note)
      putDraft({
        kind,
        path: file.path,
        value: file.note.form,
        expected: file.revision,
        dirty: false,
      });
  };
  const startNote = () => {
    if (!data) return;
    resetFeedback();
    const name = nextNotePath(data.files[scope].map((file) => file.path)).slice('/notes/'.length);
    putDraft({
      kind: 'note',
      path: name,
      expected: null,
      value: { type: 'fact', description: '', body: '', index: true, status: null, sources: [] },
      dirty: false,
    });
    putView({ ...view, path: null });
  };

  if (compact)
    return (
      <QuickMemory
        data={data}
        pending={Boolean(pending) || loading}
        update={(value) => void updateSettings(value, 'session')}
        openPage={
          openPage
            ? () => {
                try {
                  openPage();
                  setIssue((old) => (old?.channel === 'navigation' ? null : old));
                  return true;
                } catch {
                  setIssue({ channel: 'navigation', message: t('openMemoryFailed') });
                  return false;
                }
              }
            : undefined
        }
        retry={
          issue?.channel === 'load'
            ? () => {
                setNotice('');
                void refresh();
              }
            : undefined
        }
        message={loading ? t('loadingMemory') : (issue?.message ?? notice)}
        t={t}
      />
    );
  const files = data?.files[scope] ?? [];
  const notes = files.filter((file) => file.path.startsWith('/notes/'));
  const selected = files.find((file) => file.path === path);
  const rules = files.find((file) => file.path === '/RULES.md');
  const editable = scope === 'workspace' || Boolean(data?.sessionEditable);
  const groups = new Map<string, PageFile[]>();
  for (const file of notes) {
    const directory = file.path.slice('/notes/'.length, file.path.lastIndexOf('/') + 1);
    groups.set(directory, [...(groups.get(directory) ?? []), file]);
  }
  const draftFile = files.find((file) => file.path === draft?.path);
  return (
    <section
      className={styles.panel}
      aria-label={'stash · ' + t('memory')}
      onKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === 's' && draft) {
          event.preventDefault();
          if (!busy.current) void saveDraft();
        }
      }}
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <h1>
            stash <span>· {t('memory')}</span>
          </h1>
          <Button
            size="sm"
            variant="outline"
            disabled={Boolean(pending) || loading}
            onClick={() => void refresh(false, true)}
            aria-label={t('refreshMemory')}
          >
            {t('refresh')}
          </Button>
        </div>
        {data && (
          <>
            <Choice
              label={t('scopePicker')}
              disabled={Boolean(pending)}
              value={scope}
              options={[
                ...(data.sessionId
                  ? [
                      {
                        id: 'session',
                        label:
                          t('currentSession') + ' · ' + (data.sessionTitle || t('unnamedSession')),
                      },
                    ]
                  : []),
                { id: 'workspace', label: t('workspace') + ' · ' + data.title },
              ]}
              onChange={(id) => {
                if (id === 'workspace' || id === 'session')
                  guard(() =>
                    go({
                      scope: id,
                      section: id === 'session' && section === 'maintenance' ? 'notes' : section,
                      path: null,
                    }),
                  );
              }}
            />
            <SegmentedTabs
              label={t('section')}
              value={section}
              onChange={(next) => guard(() => go({ ...view, section: next, path: null }))}
              items={[
                {
                  value: 'notes',
                  label: t('notes'),
                  id: tabId + '-notes',
                  panelId: tabId + '-body',
                },
                {
                  value: 'rules',
                  label: t('rules'),
                  id: tabId + '-rules',
                  panelId: tabId + '-body',
                },
                ...(scope === 'workspace' && maintenance
                  ? [
                      {
                        value: 'maintenance' as const,
                        label: t('maintTab'),
                        id: tabId + '-maintenance',
                        panelId: tabId + '-body',
                      },
                    ]
                  : []),
                {
                  value: 'preferences',
                  label: t('preferences'),
                  id: tabId + '-preferences',
                  panelId: tabId + '-body',
                },
              ]}
            />
          </>
        )}
      </header>
      <div
        ref={scroll}
        className={styles.scroll}
        role={data ? 'tabpanel' : undefined}
        id={tabId + '-body'}
        aria-labelledby={data ? tabId + '-' + section : undefined}
      >
        {!data && (
          <div className={styles.empty}>
            <p>{issue?.message ?? t('loadingMemory')}</p>
            {issue && <Button onClick={() => void refresh()}>{t('retry')}</Button>}
          </div>
        )}
        {data && (
          <>
            {!editable && section !== 'preferences' && (
              <p className={styles.notice}>{t('sessionNotStarted')}</p>
            )}
            {section === 'maintenance' && scope === 'workspace' && maintenance && (
              <MaintenancePanel
                call={maintenance}
                archives={archives}
                activity={activity}
                sessionLabel={sessionLabel}
                refreshKey={healthRefresh}
                enabled={data.effective.enabled && data.effective.inheritWorkspace}
                openSession={openSession}
                t={t}
              />
            )}
            {section === 'preferences' && (
              <MemorySettings
                data={data}
                scope={scope}
                pending={Boolean(pending)}
                update={(value) => void updateSettings(value)}
                clear={() => setConfirm('clear')}
                t={t}
              />
            )}
            {section === 'notes' && !draft && !path && (
              <>
                <div className={styles.sectionHeading}>
                  <h2>{t('noteCount').replace('{count}', String(notes.length))}</h2>
                  <Button
                    variant="primary"
                    disabled={!editable || Boolean(pending)}
                    onClick={startNote}
                  >
                    <IconPlusOutlineRegular />
                    {t('newNote')}
                  </Button>
                </div>
                {!notes.length && (
                  <div className={styles.empty}>
                    <h3>{t('emptyNotes')}</h3>
                    <p>{t('emptyNotesHint')}</p>
                  </div>
                )}
                {[...groups]
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([directory, group]) => (
                    <section key={directory} className={styles.noteGroup}>
                      <h3>
                        {t('notesRoot')}
                        {directory ? ' / ' + directory.slice(0, -1).replaceAll('/', ' / ') : ''}
                        <span>{group.length}</span>
                      </h3>
                      {group.map((file) => (
                        <button
                          className={styles.noteCard}
                          key={file.path}
                          onClick={() => {
                            resetFeedback();
                            putView({ ...view, path: file.path });
                          }}
                        >
                          <strong>
                            {file.note?.form.description || file.path.split('/').at(-1)}
                          </strong>
                          <NoteBadges file={file} t={t} />
                          <span className={styles.hint}>{file.path.split('/').at(-1)}</span>
                        </button>
                      ))}
                    </section>
                  ))}
              </>
            )}
            {section === 'notes' && (draft || path) && (
              <div className={styles.detailToolbar}>
                <Button
                  size="sm"
                  onClick={() => guard(() => go({ ...view, path: null }))}
                  disabled={Boolean(pending)}
                >
                  <IconChevronLeftOutlineRegular />
                  {t('back')}
                </Button>
                {!draft && selected && (
                  <div className={styles.row}>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!editable || !selected.note || Boolean(pending)}
                      onClick={() => edit(selected, 'note')}
                    >
                      {t('edit')}
                    </Button>
                    <Menu
                      portal
                      autoFocus
                      align="end"
                      open={more}
                      onClose={() => setMore(false)}
                      anchor={
                        <Button
                          size="sm"
                          aria-label={t('more')}
                          aria-haspopup="menu"
                          aria-expanded={more}
                          disabled={Boolean(pending)}
                          onClick={() => setMore(!more)}
                        >
                          <IconEllipsisOutlineRegular />
                        </Button>
                      }
                      items={[
                        ...(scope === 'session'
                          ? [{ id: 'copy', label: t('copyToWorkspace'), disabled: !selected.note }]
                          : []),
                        { id: 'delete', label: t('delete'), danger: true, disabled: !editable },
                      ]}
                      onSelect={(id) => {
                        setMore(false);
                        resetFeedback();
                        if (id === 'delete') setConfirm('delete');
                        else
                          setCopy(
                            nextNotePath(
                              data.files.workspace.map((file) => file.path),
                              selected.path,
                            ).slice('/notes/'.length),
                          );
                      }}
                    />
                  </div>
                )}
              </div>
            )}
            {draft?.kind === 'note' && section === 'notes' && (
              <>
                <h2 className={styles.editorTitle}>
                  {t(draft.expected === null ? 'newNote' : 'editNote')}
                </h2>
                <NoteEditor
                  key={draft.expected === null ? 'new' : draft.path}
                  value={draft.value}
                  onChange={(value) => putDraft({ ...draft, value, dirty: true })}
                  location={draft.path}
                  onLocation={(location) => putDraft({ ...draft, path: location, dirty: true })}
                  isNew={draft.expected === null}
                  scope={scope}
                  paths={notes.map((file) => file.path)}
                  projection={draftFile?.note}
                  errors={errors}
                  disabled={Boolean(pending)}
                  t={t}
                />
              </>
            )}
            {section === 'notes' &&
              !draft &&
              path &&
              (selected ? (
                <NoteContent file={selected} scope={scope} t={t} openSession={openSession} />
              ) : (
                <p className={styles.notice}>{t('missingNote')}</p>
              ))}
            {section === 'rules' && (
              <>
                <div className={styles.sectionHeading}>
                  <h2>{t('rules')}</h2>
                  {!draft && (
                    <Button
                      variant="primary"
                      disabled={!editable || Boolean(pending)}
                      onClick={() => edit(rules, 'rules')}
                    >
                      {t('editRules')}
                    </Button>
                  )}
                </div>
                <p className={styles.hint}>{t('rulesHelp')}</p>
                {draft?.kind === 'rules' ? (
                  <textarea
                    className={styles.rulesEditor}
                    aria-label={t('content')}
                    value={draft.content}
                    disabled={Boolean(pending)}
                    onChange={(event) =>
                      putDraft({ ...draft, content: event.target.value, dirty: true })
                    }
                  />
                ) : rules?.content ? (
                  <Markdown text={rules.content} t={t} />
                ) : (
                  <div className={styles.empty}>{t('emptyRules')}</div>
                )}
              </>
            )}
          </>
        )}
      </div>
      <footer
        className={styles.footer}
        hidden={!draft && !issue && !notice && !pending && !copiedPath}
      >
        <div className={styles.feedback} aria-live="polite">
          {issue && copy === null && !confirm ? (
            <>
              <p role="alert" className={styles.error}>
                {issue.message}
              </p>
              {issue.code === 'STASH_STALE_READ' && draft ? (
                <Button
                  size="sm"
                  disabled={loading || Boolean(pending)}
                  onClick={() => void loadLatest()}
                >
                  {t('latest')}
                </Button>
              ) : (
                issue.channel === 'load' && (
                  <Button
                    size="sm"
                    disabled={loading}
                    onClick={() => void refresh(Boolean(notice))}
                  >
                    {t('retry')}
                  </Button>
                )
              )}
            </>
          ) : (
            <span>{pending ? t('saving') : notice || (draft?.dirty ? t('unsaved') : '')}</span>
          )}
          {copiedPath && (
            <Button
              size="sm"
              onClick={() => go({ scope: 'workspace', section: 'notes', path: copiedPath })}
            >
              {t('viewCopy')}
            </Button>
          )}
        </div>
        {draft && (
          <div className={styles.actions}>
            <Button
              disabled={Boolean(pending)}
              onClick={() =>
                guard(() => {
                  putDraft(null);
                  resetFeedback();
                })
              }
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(pending) || !editable || (!draft.dirty && draft.expected !== null)}
              onClick={() => void saveDraft()}
            >
              {t(
                draft.kind === 'rules'
                  ? 'saveRules'
                  : draft.expected === null
                    ? 'createNote'
                    : 'saveChanges',
              )}
            </Button>
          </div>
        )}
      </footer>
      <Modal
        className={styles.dialog!}
        contentClassName={styles.modalContent!}
        open={Boolean(leave)}
        onClose={() => {
          if (!busy.current) setLeave(null);
        }}
        title={t('leaveTitle')}
        closeLabel={t('cancel')}
        description={t('leaveHelp')}
        footer={
          <>
            <Button disabled={Boolean(pending)} onClick={() => setLeave(null)}>
              {t('keepEditing')}
            </Button>
            <Button
              disabled={Boolean(pending)}
              onClick={() => {
                putDraft(null);
                const run = leave?.run;
                setLeave(null);
                run?.();
              }}
            >
              {t('discard')}
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(pending)}
              onClick={() => {
                const run = leave?.run;
                setLeave(null);
                void saveDraft().then((ok) => {
                  if (ok && live.current) run?.();
                });
              }}
            >
              {t('saveAndContinue')}
            </Button>
          </>
        }
      />
      <Modal
        className={styles.dialog!}
        contentClassName={styles.modalContent!}
        open={Boolean(confirm)}
        onClose={() => {
          if (!busy.current) {
            setConfirm(null);
            setIssue(null);
          }
        }}
        title={t(confirm === 'delete' ? 'deleteNoteTitle' : 'clearTitle')}
        closeLabel={t('cancel')}
        tone="warning"
        description={t(
          confirm === 'delete'
            ? 'deleteFile'
            : scope === 'workspace'
              ? 'clearWorkspaceNotice'
              : 'clearSessionNotice',
        )}
        footer={
          <>
            <Button
              disabled={Boolean(pending)}
              onClick={() => {
                setConfirm(null);
                setIssue(null);
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(pending)}
              onClick={() => {
                if (!data) return;
                const action: PageEdit | null =
                  confirm === 'clear'
                    ? { op: 'clear', scope, expected: data.revisions[scope], confirm: true }
                    : selected
                      ? {
                          op: 'save',
                          scope,
                          path: selected.path,
                          content: null,
                          expected: selected.revision,
                        }
                      : null;
                if (action)
                  void runMutation(action, 'delete').then((result) => {
                    if (result && live.current) {
                      setConfirm(null);
                      putView({ ...view, path: null });
                      setNotice(t('deleted'));
                      void refresh(true);
                    }
                  });
              }}
            >
              {t(confirm === 'delete' ? 'delete' : 'confirm')}
            </Button>
          </>
        }
      >
        {confirm === 'delete' && selected && (
          <p>{selected.note?.form.description || selected.path}</p>
        )}
        {issue?.channel === 'delete' && (
          <div role="alert" className={styles.error}>
            {issue.message}
            {issue.code === 'STASH_STALE_READ' && (
              <Button
                size="sm"
                onClick={() => {
                  setConfirm(null);
                  setIssue(null);
                  void refresh();
                }}
              >
                {t('refreshMemory')}
              </Button>
            )}
          </div>
        )}
      </Modal>
      <Modal
        className={styles.dialog!}
        contentClassName={styles.modalContent!}
        open={copy !== null}
        onClose={() => {
          if (!busy.current) {
            setCopy(null);
            setIssue(null);
          }
        }}
        title={t('copyToWorkspace')}
        closeLabel={t('cancel')}
        description={t('copyHelp')}
        footer={
          <>
            <Button
              disabled={Boolean(pending)}
              onClick={() => {
                setCopy(null);
                setIssue(null);
              }}
            >
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(pending)}
              onClick={() => {
                if (copy === null || !data || !selected) return;
                let destination: string;
                try {
                  destination = notePath(copy, 'workspace');
                } catch {
                  setErrors({ path: t('invalidPath') });
                  return;
                }
                if (data.files.workspace.some((file) => file.path === destination)) {
                  setErrors({ path: t('exists') });
                  return;
                }
                setErrors({});
                void runMutation(
                  { op: 'promote', path: selected.path, destination, expected: selected.revision },
                  'copy',
                ).then((result) => {
                  if (result && live.current) {
                    setCopy(null);
                    setCopiedPath(result.file!.path);
                    setNotice(t('copiedNote'));
                    void refresh(true);
                  }
                });
              }}
            >
              {t('copyNote')}
            </Button>
          </>
        }
      >
        {data && copy !== null && (
          <>
            <p className={styles.hint}>
              {t('workspace')} · {data.title}
            </p>
            <MemoryLocation
              t={t}
              scope="workspace"
              paths={data.files.workspace.map((file) => file.path)}
              value={copy}
              onChange={setCopy}
              error={errors.path}
              disabled={Boolean(pending)}
            />
          </>
        )}
        {issue?.channel === 'copy' && (
          <p role="alert" className={styles.error}>
            {issue.message}
          </p>
        )}
      </Modal>
      <Modal
        open={Boolean(compare)}
        onClose={() => setCompare(null)}
        title={t('compareTitle')}
        closeLabel={t('cancel')}
        description={t('mergeHelp')}
        className={styles.compare!}
        contentClassName={styles.modalContent!}
        footer={
          <>
            <Button
              onClick={() => {
                putDraft(null);
                setCompare(null);
                setIssue(null);
              }}
            >
              {t('useLatest')}
            </Button>
            <Button
              variant="primary"
              disabled={draft?.kind === 'note' && Boolean(compare?.file && !compare.file.note)}
              onClick={() => {
                if (draft && compare)
                  putDraft({
                    ...draft,
                    expected: compare.file?.revision ?? null,
                    path:
                      compare.file?.path ??
                      (draft.kind === 'note' ? displayPath(draft.path, scope) : draft.path),
                    dirty: true,
                  });
                setCompare(null);
                setIssue(null);
              }}
            >
              {t('mergeLatest')}
            </Button>
          </>
        }
      >
        {compare?.file ? (
          compare.file.path === '/RULES.md' ? (
            <Markdown text={compare.file.content} t={t} />
          ) : (
            <NoteContent file={compare.file} scope={scope} t={t} openSession={openSession} />
          )
        ) : (
          <p>{t('missingNote')}</p>
        )}
      </Modal>
    </section>
  );
}
