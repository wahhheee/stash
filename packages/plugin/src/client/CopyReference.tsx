import { useState } from 'react';
import { sessionRef } from '@wahhheee/stash-core/refs';
import type { StashReference } from '../types.ts';
import type { LocaleKey } from './locales.ts';

export function referenceLink(
  id: string,
  label: string,
  range?: { from: number; to: number },
): string {
  return (
    '[' +
    label.replace(/[\r\n]/gu, ' ').replace(/[\\[\]]/gu, '\\$&') +
    '](' +
    sessionRef(id, range) +
    ')'
  );
}

export interface CopyReferenceProps {
  messageId: string;
  load: (messageId: string) => Promise<StashReference>;
  t: (key: LocaleKey) => string;
}

export function CopyReference({ messageId, load, t }: CopyReferenceProps) {
  const [state, setState] = useState<'idle' | 'pending' | 'done' | 'failed'>('idle');
  return (
    <span>
      <button
        type="button"
        disabled={state === 'pending'}
        title={t('copyReference')}
        onClick={() => {
          setState('pending');
          void load(messageId)
            .then(async (r) => {
              const label = t('referenceLabel')
                .replace('{title}', () => r.title)
                .replace('{turn}', String(r.turn))
                .replace('{time}', r.end);
              await navigator.clipboard.writeText(referenceLink(r.id, label, r));
              setState('done');
            })
            .catch(() => setState('failed'));
        }}
      >
        {t('copyReference')}
      </button>
      {state === 'done' && <span role="status">{t('copied')}</span>}
      {state === 'failed' && <span role="alert">{t('copyFailed')}</span>}
    </span>
  );
}
