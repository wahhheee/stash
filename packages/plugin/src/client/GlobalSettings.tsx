import { useEffect, useState } from 'react';
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client';
import { Switch } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import styles from './MemoryPanel.module.css';

export type CompactionForm = ConfigFormSnapshot<{ compactionNotes: boolean }>;

export function GlobalSettings({
  useForm,
  save,
  supported,
  t,
}: {
  useForm: <T>(select: (state: CompactionForm) => T) => T;
  save: (value: boolean) => Promise<boolean>;
  supported: () => Promise<boolean>;
  t: Translate;
}) {
  const form = useForm((state) => state);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let mounted = true;
    void supported().then(
      (value) => {
        if (mounted) setAvailable(value);
      },
      () => {
        if (mounted) setFailed(true);
      },
    );
    return () => {
      mounted = false;
    };
  }, [supported]);
  return (
    <div className={styles.settingRow}>
      <div>
        <strong>{t('compactTitle')}</strong>
        <p className={styles.hint}>{t('compactHelp')}</p>
        {available === false && <p className={styles.hint}>{t('compactUnsupported')}</p>}
        {form.status === 'unavailable' && <p role="status">{t('loadFailed')}</p>}
        {failed && <p role="alert">{t('compactFailed')}</p>}
      </div>
      <Switch
        label={t('compactTitle')}
        checked={form.value?.compactionNotes === true}
        disabled={busy || available !== true || form.status !== 'ready' || !form.writable}
        onChange={(next) => {
          setFailed(false);
          setBusy(true);
          void save(next)
            .then(
              (ok) => setFailed(!ok),
              () => setFailed(true),
            )
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
