import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { StashStatus } from '../types.ts';
import type { LocaleKey } from './locales.ts';

export interface StatusPanelProps {
  readonly t: (key: LocaleKey) => string;
  readonly load: () => Promise<StashStatus>;
  readonly subscribeReset: (listener: () => void) => () => void;
}

export function StatusPanel({ t, load, subscribeReset }: StatusPanelProps): ReactNode {
  const [state, setState] = useState<{ status?: StashStatus; error?: boolean }>({});
  const [revision, setRevision] = useState(0);
  useEffect(() => subscribeReset(() => setRevision((value) => value + 1)), [subscribeReset]);
  useEffect(() => {
    let active = true;
    setState({});
    void load().then(
      (status) => {
        if (active) setState({ status });
      },
      () => {
        if (active) setState({ error: true });
      },
    );
    return () => {
      active = false;
    };
  }, [load, revision]);
  return (
    <section style={{ padding: 20, fontSize: 14, lineHeight: 1.7 }} aria-label="stash">
      <h2>stash</h2>
      <p role="status">
        {t(state.error ? 'disconnected' : state.status ? 'connected' : 'connecting')}
      </p>
      {state.status && (
        <dl>
          <dt>{t('version')}</dt>
          <dd>{state.status.version}</dd>
          <dt>{t('host')}</dt>
          <dd>{state.status.hostVersion}</dd>
        </dl>
      )}
      <p>{t('phase')}</p>
      <button type="button" onClick={() => setRevision((value) => value + 1)}>
        {t('refresh')}
      </button>
    </section>
  );
}
