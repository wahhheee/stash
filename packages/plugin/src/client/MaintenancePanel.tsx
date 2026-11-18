import { useEffect, useRef, useState } from 'react';
import type { MaintenanceAction, MaintenanceData } from '../adapters/maintenance-schema.ts';
import { randomUuid } from '@deepseek-ai/dsh-client-connection/src/client/random-uuid.ts';
import { Button } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import styles from './MemoryPanel.module.css';

export type MaintenanceCall = (action: MaintenanceAction) => Promise<MaintenanceData>;

export function MaintenancePanel({
  call,
  t,
  openSession,
  enabled,
  refreshKey = 0,
}: {
  call: MaintenanceCall;
  t: Translate;
  openSession?: ((id: string) => void) | undefined;
  enabled: boolean;
  refreshKey?: number;
}) {
  const [data, setData] = useState<MaintenanceData | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [checked, setChecked] = useState<number[]>([]),
    [rollback, setRollback] = useState<string | null>(null),
    [done, setDone] = useState('');
  const startId = useRef<string | null>(null);
  const token = useRef(0),
    lock = useRef(false);

  async function run(action: MaintenanceAction) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(false);
    setDone('');
    const seq = ++token.current;
    try {
      const result = await call(action);
      if (seq !== token.current) return;
      setData(result);
      setChecked([]);
      setRollback(null);
      if (action.op === 'apply' || action.op === 'rollback') {
        setDone(t(action.op === 'apply' ? 'maintApplied' : 'maintReverted'));
        try {
          const latest = await call({ op: 'inspect' });
          if (seq === token.current) setData(latest);
        } catch {
          if (seq === token.current) setError(true);
        }
      }
      if (result.started) {
        setDone(t('maintStarted'));
        try {
          await openSession?.(result.started);
          startId.current = null;
        } catch {
          if (seq === token.current) setError(true);
        }
      }
    } catch {
      if (seq === token.current) setError(true);
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
    setRollback(null);
    setDone('');
    setError(false);
    void call({ op: 'inspect' })
      .then(
        (r) => {
          if (seq === token.current) setData(r);
        },
        () => {
          if (seq === token.current) setError(true);
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
  const h = data?.health,
    review = data?.review;
  return (
    <section className={styles.maintenance} aria-label={t('maint')}>
      <div className={styles.sectionHeading}>
        <h2>{t('maint')}</h2>
      </div>
      <p>{t('maintHint')}</p>
      {busy && <p role="status">{t('loadingMemory')}</p>}
      {error && (
        <p role="alert">
          {t(
            done === t('maintStarted')
              ? 'maintNavigationError'
              : done
                ? 'maintSavedRefresh'
                : 'maintError',
          )}
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {h && (
        <>
          <dl>
            {[
              [t('notes'), h.notes],
              [t('maintRules'), `${h.rulesUsed} / ${h.rulesLimit}`],
              [t('maintFold'), t(h.folded ? 'on' : 'off')],
              [t('maintUnread').replace('{days}', String(h.unreadDays)), h.unread],
              [t('maintAdded'), h.added],
              [t('maintDifferent'), h.verifiedDifferent],
              [t('maintUnknown'), h.verifiedUnknown],
            ].map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <Button
            disabled={busy || !enabled}
            onClick={() => void run({ op: 'start', requestId: (startId.current ??= randomUuid()) })}
          >
            {t('maintStart')}
          </Button>
        </>
      )}
      {data?.runs.map((r) => (
        <article key={r.id}>
          <strong>
            {t(
              (
                {
                  planning: 'maintPlanning',
                  proposed: 'maintProposed',
                  applied: 'maintApplied',
                  reverted: 'maintReverted',
                  stale: 'maintStale',
                } as const
              )[r.status],
            )}
          </strong>
          <div>
            <Button disabled={busy} onClick={() => openSession?.(r.id)}>
              {r.id}
            </Button>
          </div>
          {r.status === 'proposed' && (
            <Button disabled={busy} onClick={() => void run({ op: 'review', id: r.id })}>
              {t('maintReview')}
            </Button>
          )}
          {r.status === 'applied' &&
            (rollback === r.id ? (
              <>
                <p>{t('maintUndoHint')}</p>
                <Button disabled={busy} onClick={() => void run({ op: 'rollback', id: r.id })}>
                  {t('confirm')}
                </Button>
                <Button disabled={busy} onClick={() => setRollback(null)}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              <Button disabled={busy} onClick={() => setRollback(r.id)}>
                {t('maintUndo')}
              </Button>
            ))}
        </article>
      ))}
      {review && (
        <article>
          <h3>{t('maintReview')}</h3>
          {review.changes.map((c) => (
            <details key={c.path}>
              <summary>
                {c.path}
                {c.redirect && ` → ${c.redirect}`}
              </summary>
              <strong>{t('maintBefore')}</strong>
              <pre>{c.before ?? '∅'}</pre>
              <strong>{t('maintAfter')}</strong>
              <pre>{c.after ?? '∅'}</pre>
            </details>
          ))}
          {review.rules.map((r) => (
            <label key={r.line}>
              <input
                type="checkbox"
                checked={checked.includes(r.line)}
                onChange={(e) =>
                  setChecked(
                    e.target.checked ? [...checked, r.line] : checked.filter((l) => l !== r.line),
                  )
                }
              />
              {t('maintRule')} {r.line}
              <pre>
                {r.before ?? '∅'} → {r.after ?? '∅'}
              </pre>
            </label>
          ))}
          <Button
            disabled={busy || checked.length !== review.rules.length}
            onClick={() =>
              void run({
                op: 'apply',
                id: review.id,
                revision: review.revision,
                confirmed: checked,
              })
            }
          >
            {t('maintApply')}
          </Button>
        </article>
      )}
    </section>
  );
}
