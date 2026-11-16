import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { MemoryPageData, PageAction } from '../page-types.ts';
import type { SwitchRecord } from '@wahhheee/stash-core';
import type { LocaleKey } from './locales.ts';
import styles from './MemoryPanel.module.css';

export interface MemoryPanelProps {
  t: (key: LocaleKey) => string;
  load: () => Promise<MemoryPageData>;
  change: (action: PageAction) => Promise<MemoryPageData>;
  subscribeReset: (listener: () => void) => () => void;
  compact?: boolean;
}

export function MemoryPanel({
  t,
  load,
  change,
  subscribeReset,
  compact = false,
}: MemoryPanelProps): ReactNode {
  const [data, setData] = useState<MemoryPageData>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'workspace' | 'session'>('workspace');
  const [path, setPath] = useState('/RULES.md');
  const [content, setContent] = useState('');
  const [expected, setExpected] = useState<string | null>(null);
  const [destination, setDestination] = useState('');
  const [dirty, setDirty] = useState(false);
  const [confirmation, setConfirmation] = useState<{ text: string; run: () => void }>();
  const live = useRef(true);
  const pending = useRef(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(
    () =>
      subscribeReset(() => {
        if (pending.current) return;
        if (dirtyRef.current) setError(t('changedWhileEditing'));
        else setRevision((value) => value + 1);
      }),
    [subscribeReset, t],
  );
  useEffect(() => {
    let active = true;
    setBusy(true);
    void load()
      .then(
        (value) => {
          if (active) {
            setData(value);
            setError('');
          }
        },
        () => {
          if (active) setError(t('loadFailed'));
        },
      )
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [load, revision, t]);
  useEffect(() => {
    if (dirty) return;
    const file = data?.files[scope].find((file) => file.path === path);
    setContent(file?.content ?? '');
    setExpected(file?.revision ?? null);
  }, [data, scope, path, dirty]);
  const guard = (run: () => void) => {
    if (dirty)
      setConfirmation({
        text: t('discardDraft'),
        run: () => {
          setDirty(false);
          run();
        },
      });
    else run();
  };
  const submit = async (action: PageAction) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const value = await change(action);
      if (live.current) {
        setData(value);
        if (action.op !== 'switches') setDirty(false);
      }
    } catch (cause) {
      if (live.current)
        setError(t('saveFailed') + (cause instanceof Error ? ' ' + cause.message : ''));
    } finally {
      pending.current = false;
      if (live.current) setBusy(false);
    }
  };
  const switches = (level: 'workspace' | 'session') => {
    if (!data || (level === 'session' && !data.sessionId)) return null;
    const value = data[level];
    const update = (patch: Partial<SwitchRecord>) =>
      void submit({ op: 'switches', scope: level, value: { ...value, ...patch } });
    return (
      <fieldset disabled={busy || !data.globalEnabled}>
        <legend>{t(level)}</legend>
        {(['enabled', 'writable'] as const).map((key) => (
          <label key={key}>
            {t(key)}
            <select
              aria-label={t(level) + ' ' + t(key)}
              disabled={key === 'writable' && !data.effective.enabled}
              value={value[key] === null ? 'inherit' : String(value[key])}
              onChange={(event) =>
                update({
                  [key]: event.target.value === 'inherit' ? null : event.target.value === 'true',
                })
              }
            >
              <option value="inherit">{t('inherit')}</option>
              <option value="true">{t('on')}</option>
              <option value="false">{t('off')}</option>
            </select>
          </label>
        ))}
        {level === 'session' &&
          (['discoverable', 'inheritWorkspace'] as const).map((key) => (
            <label key={key}>
              <input
                type="checkbox"
                disabled={!data.effective.enabled}
                checked={value[key]}
                onChange={(event) => update({ [key]: event.target.checked })}
              />
              {t(key)}
            </label>
          ))}
      </fieldset>
    );
  };
  const body = (
    <>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">{t('connecting')}</p>}
      {data && (
        <>
          {!compact && (
            <>
              <h2>stash · {t('memory')}</h2>
              <p>{data.title}</p>
            </>
          )}
          <p role="status">
            {t('enabled')}: {t(data.effective.enabled ? 'on' : 'off')} · {t('source')}:{' '}
            {t(data.effective.source)}
          </p>
          {!data.globalEnabled && <p>{t('globalOff')}</p>}
          {!compact && switches('workspace')}
          {switches('session')}
          {!compact && (
            <>
              <p className={styles.hint}>{t('humanEdit')}</p>
              {scope === 'session' && !data.sessionEditable && <p>{t('sessionNotStarted')}</p>}
              <label>
                {t('scope')}
                <select
                  aria-label={t('scope')}
                  disabled={busy}
                  value={scope}
                  onChange={(event) => {
                    const nextScope = event.target.value as typeof scope;
                    guard(() => {
                      setScope(nextScope);
                      setPath('/RULES.md');
                    });
                  }}
                >
                  <option value="workspace">{t('workspace')}</option>
                  {data.sessionId && <option value="session">{t('session')}</option>}
                </select>
              </label>
              <label>
                {t('file')}
                <select
                  aria-label={t('file')}
                  disabled={busy}
                  value={data.files[scope].some((file) => file.path === path) ? path : ''}
                  onChange={(event) => {
                    const nextPath = event.target.value;
                    guard(() => setPath(nextPath));
                  }}
                >
                  <option value="">{t('newFile')}</option>
                  {data.files[scope].map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.path}
                    </option>
                  ))}
                </select>
              </label>
              <button
                disabled={busy}
                onClick={() =>
                  guard(() => {
                    setPath('/notes/new.md');
                    setContent('---\ntype: fact\ndescription: \n---\n');
                    setExpected(null);
                    setDirty(true);
                  })
                }
              >
                {t('newFile')}
              </button>
              <label>
                {t('path')}
                <input
                  aria-label={t('path')}
                  value={path}
                  disabled={busy || expected !== null}
                  onChange={(event) => {
                    setPath(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <textarea
                aria-label={t('content')}
                spellCheck={false}
                value={content}
                disabled={busy}
                onChange={(event) => {
                  setContent(event.target.value);
                  setDirty(true);
                }}
              />
              <div className={styles.actions}>
                <button
                  disabled={busy || !dirty || (scope === 'session' && !data.sessionEditable)}
                  onClick={() => void submit({ op: 'save', scope, path, content, expected })}
                >
                  {t('save')}
                </button>
                <button
                  disabled={
                    busy ||
                    expected === null ||
                    path === '/RULES.md' ||
                    (scope === 'session' && !data.sessionEditable)
                  }
                  onClick={() =>
                    setConfirmation({
                      text: t('deleteFile') + ' ' + path,
                      run: () => void submit({ op: 'save', scope, path, content: null, expected }),
                    })
                  }
                >
                  {t('delete')}
                </button>
              </div>
              {scope === 'session' && expected && path.startsWith('/notes/') && (
                <>
                  <label>
                    {t('destination')}
                    <input
                      aria-label={t('destination')}
                      value={destination}
                      placeholder={path}
                      onChange={(event) => setDestination(event.target.value)}
                    />
                  </label>
                  <button
                    disabled={busy || dirty}
                    onClick={() =>
                      void submit({
                        op: 'promote',
                        path,
                        destination: destination || path,
                        expected,
                      })
                    }
                  >
                    {t('promote')}
                  </button>
                </>
              )}
              <hr />
              <button
                disabled={busy || (scope === 'session' && !data.sessionEditable)}
                onClick={() =>
                  setConfirmation({
                    text: t(scope === 'workspace' ? 'clearWorkspaceNotice' : 'clearSessionNotice'),
                    run: () =>
                      void submit({
                        op: 'clear',
                        scope,
                        expected: data.revisions[scope],
                        confirm: true,
                      }),
                  })
                }
              >
                {t(scope === 'workspace' ? 'clearWorkspace' : 'clearSession')}
              </button>
            </>
          )}
        </>
      )}
      {confirmation && (
        <div role="alertdialog" aria-label={t('confirm')} className={styles.confirm}>
          <p>{confirmation.text}</p>
          <button
            disabled={busy}
            onClick={() => {
              confirmation.run();
              setConfirmation(undefined);
            }}
          >
            {t('confirm')}
          </button>
          <button onClick={() => setConfirmation(undefined)}>{t('cancel')}</button>
        </div>
      )}
      <button disabled={busy} onClick={() => guard(() => setRevision((value) => value + 1))}>
        {t('refresh')}
      </button>
    </>
  );
  return compact ? (
    <details className={styles.compact}>
      <summary>stash</summary>
      <div className={styles.panel}>{body}</div>
    </details>
  ) : (
    <section className={styles.panel} aria-label="stash" aria-busy={busy}>
      {body}
    </section>
  );
}
