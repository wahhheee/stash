import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import type {
  MaintenanceAction,
  MaintenanceData,
  MaintenanceMode,
} from '../adapters/maintenance-schema.ts';
import { randomUuid } from '@deepseek-ai/dsh-client-connection/src/client/random-uuid.ts';
import { Button } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import {
  IconLayersOutlineRegular,
  IconPlusOutlineRegular,
  IconChevronRightOutlineRegular,
  IconClockOutlineRegular,
  IconArchiveOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx';
import { MaintenanceOverview, PlanReview } from './MaintenanceDetails.tsx';
import styles from './MaintenancePanel.module.css';

export type MaintenanceCall = (action: MaintenanceAction) => Promise<MaintenanceData>;

export interface ArchiveSource {
  getSnapshot: () => readonly string[];
  subscribe: (listener: () => void) => () => void;
}

const noActivity = { subscribe: () => () => {}, getSnapshot: () => '' };
const empty: readonly string[] = [];
const noArchives: ArchiveSource = { getSnapshot: () => empty, subscribe: () => () => {} };

export function MaintenancePanel({
  call,
  t,
  openSession,
  enabled,
  sessionLabel,
  archives = noArchives,
  activity = noActivity,
  refreshKey = 0,
}: {
  call: MaintenanceCall;
  archives?: ArchiveSource | undefined;
  activity?:
    { subscribe: (listener: () => void) => () => void; getSnapshot: () => string } | undefined;
  t: Translate;
  openSession?: ((id: string) => void) | undefined;
  enabled: boolean;
  sessionLabel?: ((id: string) => { title?: string; updatedAt: number } | undefined) | undefined;
  refreshKey?: number;
}) {
  const [data, setData] = useState<MaintenanceData | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<'' | 'navigation' | 'action' | 'inspect' | 'refresh' | 'discard'>(
      '',
    ),
    [checked, setChecked] = useState<number[]>([]),
    [confirm, setConfirm] = useState<{ op: 'rollback' | 'discard'; id: string } | null>(null),
    [done, setDone] = useState('');
  const startId = useRef<string | null>(null);
  const [mode, setMode] = useState<MaintenanceMode>('review');
  const modeGroup = useId();
  const [attempt, setAttempt] = useState<MaintenanceMode | null>(null);
  const blockReason = busy ? 'loadingMemory' : !enabled ? 'maintDisabled' : null;
  const reason = attempt && blockReason;
  useEffect(() => setAttempt(null), [blockReason]);
  const token = useRef(0),
    lock = useRef(false);

  async function enter(id: string, seq = token.current) {
    try {
      await openSession?.(id);
    } catch {
      if (seq === token.current) setError('navigation');
    }
  }

  async function run(action: MaintenanceAction) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setDone('');
    const seq = ++token.current;
    try {
      const result = await call(action);
      if (seq !== token.current) return;
      setData(result);
      setChecked([]);
      setConfirm(null);
      if (action.op === 'discard') setDone(t('maintDiscarded'));
      if (action.op === 'apply' || action.op === 'rollback') {
        setDone(t(action.op === 'apply' ? 'maintApplied' : 'maintReverted'));
        try {
          const latest = await call({ op: 'inspect' });
          if (seq === token.current) setData(latest);
        } catch {
          if (seq === token.current) setError('refresh');
        }
      }
      if (result.started) {
        setDone(t('maintStarted'));
        startId.current = null;
        setMode('review');
        await enter(result.started, seq);
      }
    } catch {
      if (seq === token.current) setError(action.op === 'discard' ? 'discard' : 'action');
    } finally {
      if (seq === token.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }

  useEffect(() => {
    const seq = ++token.current;
    lock.current = true;
    setBusy(true);
    setData(null);
    setChecked([]);
    setConfirm(null);
    setDone('');
    setError('');
    void call({ op: 'inspect' })
      .then(
        (r) => {
          if (seq === token.current) setData(r);
        },
        () => {
          if (seq === token.current) setError('inspect');
        },
      )
      .finally(() => {
        if (seq === token.current) {
          lock.current = false;
          setBusy(false);
        }
      });
    return () => {
      token.current++;
      lock.current = false;
    };
  }, [call, refreshKey]);
  const archivedIds = useSyncExternalStore(archives.subscribe, archives.getSnapshot);
  const activityKey = useSyncExternalStore(activity.subscribe, activity.getSnapshot);
  const lastActivity = useRef(activityKey);
  const lastArchives = useRef(archivedIds);
  useEffect(() => {
    if (busy || lock.current) return;
    const activityChanged = lastActivity.current !== activityKey;
    lastActivity.current = activityKey;
    if (!activityChanged && lastArchives.current === archivedIds) return;
    const previous = lastArchives.current;
    lastArchives.current = archivedIds;
    if (
      !activityChanged &&
      ![...previous, ...archivedIds].some(
        (id) => id.startsWith('stash-maint-') && previous.includes(id) !== archivedIds.includes(id),
      )
    )
      return;
    const seq = token.current;
    let live = true;
    void call({ op: 'inspect' }).then(
      (fresh) => {
        if (live && seq === token.current)
          setData((current) => ({
            ...fresh,
            review: fresh.runs.some(
              (r) =>
                r.status === 'proposed' &&
                r.id === current?.review?.id &&
                (!r.revision || r.revision === current?.review?.revision),
            )
              ? (current?.review ?? null)
              : null,
          }));
      },
      () => {
        if (live && seq === token.current) setError('inspect');
      },
    );
    return () => {
      live = false;
    };
  }, [archivedIds, activityKey, busy, call]);
  const dateFormat = new Intl.DateTimeFormat(document.documentElement.lang || undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const records = data?.runs
    .filter((r) => !archivedIds.includes(r.id) || r.status === 'applied' || r.status === 'reverted')
    .map((run) => ({ run, meta: sessionLabel?.(run.id) }))
    .sort(
      (a, b) =>
        (b.meta?.updatedAt ?? 0) - (a.meta?.updatedAt ?? 0) || a.run.id.localeCompare(b.run.id),
    );
  const review = data?.review;
  return (
    <section className={styles.page} aria-label={t('maint')}>
      <header className={styles.intro}>
        <div className={styles.introTitle}>
          <span className={styles.iconTile}>
            <IconLayersOutlineRegular size={22} />
          </span>
          <h2>{t('maint')}</h2>
        </div>
        <fieldset className={styles.modes}>
          <legend>{t('maintMode')}</legend>
          {(['review', 'auto'] as const).map((value) => (
            <label key={value}>
              <input
                type="radio"
                name={modeGroup}
                checked={mode === value}
                aria-disabled={blockReason ? true : undefined}
                aria-describedby={reason && attempt === value ? modeGroup + '-reason' : undefined}
                onClick={() => setAttempt(blockReason ? value : null)}
                onChange={() => {
                  if (blockReason) {
                    setAttempt(value);
                    return;
                  }
                  setAttempt(null);
                  startId.current = null;
                  setMode(value);
                }}
              />
              {t(value === 'auto' ? 'maintAuto' : 'maintManual')}
            </label>
          ))}
        </fieldset>
        <p hidden={Boolean(reason)}>{t(mode === 'auto' ? 'maintAutoHint' : 'maintHint')}</p>
        <Button
          variant="primary"
          icon={<IconPlusOutlineRegular />}
          disabled={!data || busy || !enabled}
          onClick={() =>
            void run({
              op: 'start',
              mode,
              requestId: (startId.current ??= randomUuid()),
            })
          }
        >
          {t(mode === 'auto' ? 'maintStartAuto' : 'maintStart')}
        </Button>
        {!enabled && !reason && <small>{t('maintDisabled')}</small>}
        <div className={styles.modeNotice} role="status" aria-atomic="true">
          {reason && (
            <div id={modeGroup + '-reason'}>
              <strong>{t('maintModeBlocked')}</strong>
              <p>{t(reason)}</p>
            </div>
          )}
        </div>
      </header>
      {busy && (
        <p className={styles.feedback} role="status">
          {t('loadingMemory')}
        </p>
      )}
      {done && (
        <p className={styles.feedback} role="status">
          {done}
        </p>
      )}
      {error && (
        <p className={styles.feedback} role="alert">
          {t(
            (
              {
                navigation: 'maintNavigationError',
                action: 'maintError',
                discard: 'maintDiscardError',
                refresh: 'maintSavedRefresh',
                inspect: 'maintInspectError',
              } as const
            )[error],
          )}
        </p>
      )}
      {records && (
        <section aria-label={t('maintRecords')} className={styles.records}>
          <h3>
            {t('maintRecords')} <span className={styles.count}>{records.length}</span>
          </h3>
          {!records.length && (
            <div className={styles.empty}>
              <IconClockOutlineRegular size={22} />
              <strong>{t('maintEmpty')}</strong>
              <p>{t('maintEmptyHint')}</p>
            </div>
          )}
          {records.map(({ run: r, meta }) => {
            const status = t(
              (
                {
                  planning: 'maintPlanning',
                  editing: 'maintEditing',
                  unchanged: 'maintUnchanged',
                  proposed: 'maintProposed',
                  applied: 'maintApplied',
                  reverted: 'maintReverted',
                  stale: 'maintStale',
                } as const
              )[r.status],
            );
            const title = meta?.title?.trim() || `${t('maintSession')} · ${r.id.slice(-6)}`;
            const selected = review?.id === r.id;
            const archived = r.archived || archivedIds.includes(r.id);
            const discardable = r.status !== 'applied' && r.status !== 'reverted';
            const confirming =
              confirm?.id === r.id &&
              (discardable
                ? confirm.op === 'discard'
                : r.status === 'applied' && confirm.op === 'rollback');
            return (
              <article key={r.id} aria-label={`${title} · ${status}`} className={styles.record}>
                <div className={styles.recordTop}>
                  <div className={styles.identity}>
                    <span className={styles.badge} data-state={r.status}>
                      {status}
                    </span>
                    <h4>{title}</h4>
                    <div className={styles.recordInfo}>
                      {archived && <span>{t('maintArchived')}</span>}
                      {r.mode === 'auto' && <span>{t('maintAuto')}</span>}
                      {meta && (
                        <time dateTime={new Date(meta.updatedAt).toISOString()}>
                          {t('maintUpdated').replace('{time}', dateFormat.format(meta.updatedAt))}
                        </time>
                      )}
                    </div>
                  </div>
                  <div className={styles.actions}>
                    {r.status === 'proposed' && (
                      <Button
                        variant="primary"
                        aria-expanded={selected}
                        disabled={busy}
                        onClick={() => {
                          if (selected) {
                            setData((prev) => prev && { ...prev, review: null });
                            setChecked([]);
                          } else void run({ op: 'review', id: r.id });
                        }}
                      >
                        {t(selected ? 'maintHideReview' : 'maintReview')}
                      </Button>
                    )}
                    {openSession && !archived && (
                      <Button variant="outline" disabled={busy} onClick={() => void enter(r.id)}>
                        {t('openSession')} <IconChevronRightOutlineRegular />
                      </Button>
                    )}
                  </div>
                </div>
                <div className={styles.meta}>
                  <details className={styles.id}>
                    <summary>{t('maintIdentifier')}</summary>
                    <code>{r.id}</code>
                  </details>
                  {(discardable || r.status === 'applied') && !confirming && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      icon={discardable ? <IconArchiveOutlineRegular /> : undefined}
                      onClick={() =>
                        setConfirm({ op: discardable ? 'discard' : 'rollback', id: r.id })
                      }
                    >
                      {t(discardable ? 'maintDiscard' : 'maintUndo')}
                    </Button>
                  )}
                </div>
                {confirming && (
                  <div className={styles.undo}>
                    <p>{t(discardable ? 'maintDiscardHint' : 'maintUndoHint')}</p>
                    <div className={styles.actions}>
                      <Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>
                        {t('cancel')}
                      </Button>
                      <Button variant="primary" disabled={busy} onClick={() => void run(confirm)}>
                        {t(discardable ? 'maintDiscardConfirm' : 'maintUndoConfirm')}
                      </Button>
                    </div>
                  </div>
                )}
                {selected && review && !confirming && (
                  <PlanReview
                    review={review}
                    checked={checked}
                    selectAll={setChecked}
                    busy={busy}
                    t={t}
                    toggle={(line) =>
                      setChecked((prev) =>
                        prev.includes(line) ? prev.filter((l) => l !== line) : [...prev, line],
                      )
                    }
                    apply={() =>
                      void run({
                        op: 'apply',
                        id: r.id,
                        revision: review.revision,
                        confirmed: checked,
                      })
                    }
                  />
                )}
              </article>
            );
          })}
        </section>
      )}
      {data && <MaintenanceOverview health={data.health} t={t} />}
    </section>
  );
}
