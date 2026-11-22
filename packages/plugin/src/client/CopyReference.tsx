import { useEffect, useRef, useState } from 'react';
import {
  ReferenceIconRegular,
  Tooltip,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
} from './dsh-ui.ts';
import { sessionRef } from '@wahhheee/stash-core/refs';
import type { StashReference } from '../types.ts';
import type { LocaleKey } from './locales.ts';
import css from './CopyReference.module.css';

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
  const busy = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    setState('idle');
    busy.current = false;
    return () => {
      generation.current++;
    };
  }, [messageId]);
  useEffect(() => {
    if (state !== 'done') return;
    const timer = setTimeout(() => setState('idle'), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  const feedback =
    state === 'done'
      ? t('copied')
      : state === 'failed'
        ? t('copyFailed')
        : state === 'pending'
          ? t('copyPending')
          : '';
  return (
    <>
      <Tooltip
        label={feedback || t('copyReference') + '\n' + t('copyReferenceHint')}
        side="bottom"
        portal
        maxWidth={300}
      >
        <button
          type="button"
          className={css.action}
          aria-label={t('copyReference')}
          aria-disabled={state === 'pending'}
          aria-busy={state === 'pending'}
          onClick={() => {
            if (busy.current) return;
            busy.current = true;
            const current = generation.current;
            setState('pending');
            void load(messageId)
              .then(async (r) => {
                if (current !== generation.current) return;
                const label = t('referenceLabel')
                  .replace('{title}', () => r.title)
                  .replace('{turn}', String(r.turn))
                  .replace('{time}', r.end);
                await navigator.clipboard.writeText(referenceLink(r.id, label, r));
                if (current === generation.current) setState('done');
              })
              .catch(() => {
                if (current === generation.current) setState('failed');
              })
              .finally(() => {
                if (current === generation.current) busy.current = false;
              });
          }}
        >
          {state === 'done' ? (
            <IconCheckOutlineRegular />
          ) : state === 'failed' ? (
            <IconCloseOutlineRegular />
          ) : (
            <ReferenceIconRegular kind="session" />
          )}
        </button>
      </Tooltip>
      <span className={css.announcement} role="status">
        {state === 'failed' ? '' : feedback}
      </span>
      {state === 'failed' && (
        <span className={css.announcement} role="alert">
          {feedback}
        </span>
      )}
    </>
  );
}
