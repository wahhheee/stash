import type { MaintenanceData } from '../adapters/maintenance-schema.ts';
import { DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives';
import { IconInfoOutlineRegular, Tooltip } from './dsh-ui.ts';
import { Button } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import styles from './MaintenancePanel.module.css';

export function MaintenanceOverview({
  health: h,
  t,
}: {
  health: MaintenanceData['health'];
  t: Translate;
}) {
  const groups: {
    name: string;
    help?: string;
    rows: [name: string, value: string | number, help?: string][];
  }[] = [
    {
      name: t('maintActivity'),
      rows: [
        [t('maintUnread').replace('{days}', String(h.unreadDays)), h.unread],
        [t('maintAdded'), h.added],
      ],
    },
    {
      name: t('maintCapacity'),
      rows: [[t('maintFold'), t(h.folded ? 'maintIndexFolded' : 'maintIndexFull')]],
    },
    {
      name: t('maintVerification'),
      help: t('maintVerificationHelp'),
      rows: [
        [t('maintDifferent'), h.verifiedDifferent, t('maintDifferentHelp')],
        [t('maintUnknown'), h.verifiedUnknown, t('maintUnknownHelp')],
      ],
    },
  ];
  function metricLabel(name: string, help?: string) {
    if (!help) return name;
    return (
      <>
        {name}{' '}
        <Tooltip label={help} side="top" portal maxWidth={320} openOnClick>
          <button
            type="button"
            className={styles.helpButton}
            aria-label={t('maintHelpLabel').replace('{name}', name)}
          >
            <IconInfoOutlineRegular size={14} />
          </button>
        </Tooltip>
      </>
    );
  }
  return (
    <section className={styles.overview} aria-label={t('maintOverview')}>
      <h3>{t('maintOverview')}</h3>
      <dl className={styles.metrics}>
        <div>
          <dt>{t('notes')}</dt>
          <dd>{h.notes}</dd>
        </div>
        <div>
          <dt>{t('maintRules')}</dt>
          <dd>
            {h.rulesUsed} <small>/ {h.rulesLimit} tokens</small>
          </dd>
        </div>
      </dl>
      <details className={styles.more}>
        <summary>{t('maintMetrics')}</summary>
        <div className={styles.metricGroups}>
          {groups.map((g) => (
            <div key={g.name}>
              <h4>{metricLabel(g.name, g.help)}</h4>
              <dl>
                {g.rows.map(([name, value, help]) => (
                  <div key={name}>
                    <dt>{metricLabel(name, help)}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

export function PlanReview({
  review,
  checked,
  toggle,
  selectAll,
  apply,
  busy,
  t,
}: {
  review: NonNullable<MaintenanceData['review']>;
  checked: number[];
  toggle: (line: number) => void;
  selectAll: (lines: number[]) => void;
  apply: () => void;
  busy: boolean;
  t: Translate;
}) {
  const all = review.rules.length > 0 && checked.length === review.rules.length;
  const expand = (n: number) => t('maintExpand').replace('{n}', String(n));
  const labels = {
    codeLabel: t('maintDiffs'),
    copy: t('maintCopyDiff'),
    copied: t('copyDone'),
    wrapLabel: t('maintWrap'),
    unwrapLabel: t('maintUnwrap'),
    collapseAria: t('maintCollapse'),
    collapse: t('maintCollapse'),
    expandAria: expand,
    expand,
  };
  return (
    <section aria-label={t('maintReview')} className={styles.review}>
      <h4>
        {t('maintDiffs')} <span>{review.changes.length}</span>
      </h4>
      {review.changes.map((c) => (
        <div key={c.path} className={styles.diff}>
          <DiffBlock
            diffs={[{ path: c.path, oldText: c.before, newText: c.after ?? '' }]}
            labels={labels}
          />
          {c.redirect && (
            <p>
              {t('maintRedirect')} <code>{c.redirect}</code>
            </p>
          )}
        </div>
      ))}
      {review.rules.length > 0 && (
        <fieldset disabled={busy} className={styles.checks}>
          <legend>
            {t('maintChecks')} · {checked.length} / {review.rules.length}
          </legend>
          <label className={styles.selectAll}>
            <input
              type="checkbox"
              checked={all}
              ref={(el) => {
                if (el) el.indeterminate = !all && checked.length > 0;
              }}
              onChange={() => selectAll(all ? [] : review.rules.map((r) => r.line))}
            />
            {t('maintAll')}
          </label>
          {review.rules.map((r) => (
            <label key={r.line}>
              <input
                type="checkbox"
                checked={checked.includes(r.line)}
                onChange={() => toggle(r.line)}
              />
              <span>
                {t('maintRule').replace('{line}', String(r.line))}
                {r.before !== null && <code>− {r.before}</code>}
                {r.after !== null && <code>+ {r.after}</code>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <Button
        variant="primary"
        disabled={busy || checked.length !== review.rules.length}
        onClick={apply}
      >
        {t('maintApply')}
      </Button>
    </section>
  );
}
