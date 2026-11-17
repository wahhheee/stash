import { useState } from 'react';
import { Button, Markdown } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import type { PageFile } from '../page-types.ts';
import type { MemoryScope } from './memory-state.ts';
import { splitSource, sourceSession, copyMemoryText } from './memory-state.ts';
import { displayPath } from './MemoryLocation.tsx';
import { typeName } from './NoteEditor.tsx';
import styles from './MemoryPanel.module.css';

export function NoteBadges({ file, t }: { file: PageFile; t: Translate }) {
  const note = file.note?.form;
  return (
    note && (
      <div className={styles.badges}>
        <span>{typeName(note.type, t)}</span>
        {note.status && <span>{note.status === 'archived' ? t('archived') : note.status}</span>}
        {!note.index && <span>{t('excluded')}</span>}
      </div>
    )
  );
}

function Source({
  raw,
  t,
  openSession,
}: {
  raw: string;
  t: Translate;
  openSession: ((id: string) => void) | undefined;
}) {
  const { name, target } = splitSource(raw);
  const [feedback, setFeedback] = useState('');
  const id = sourceSession(target);
  return (
    <li className={styles.sourceItem}>
      <span>{name || target}</span>
      {name && <code className={styles.hint}>{target}</code>}
      <div className={styles.row}>
        {id && openSession && (
          <Button size="sm" onClick={() => openSession(id!)}>
            {t('openSession')}
          </Button>
        )}
        {/^https?:\/\//iu.test(target) && (
          <a href={target} target="_blank" rel="noreferrer">
            {t('openLink')}
          </a>
        )}
        <Button
          size="sm"
          onClick={() =>
            void copyMemoryText(raw).then(
              () => setFeedback(t('copyDone')),
              () => setFeedback(t('copyFailed')),
            )
          }
        >
          {t('copyTarget')}
        </Button>
        <span className={styles.hint} role="status">
          {feedback}
        </span>
      </div>
    </li>
  );
}

export function NoteContent({
  file,
  scope,
  t,
  openSession,
}: {
  file: PageFile;
  scope: MemoryScope;
  t: Translate;
  openSession?: ((id: string) => void) | undefined;
}) {
  const [feedback, setFeedback] = useState('');
  const note = file.note?.form;
  return (
    <div className={styles.noteContent}>
      <NoteBadges file={file} t={t} />
      <h2>{note?.description || file.path.split('/').at(-1)}</h2>
      {note ? (
        <Markdown text={note.body} t={t} openSession={openSession} />
      ) : (
        <>
          <p className={styles.notice}>{t('invalidNote')}</p>
          <pre className={styles.raw}>{file.content}</pre>
        </>
      )}
      {(Boolean(note?.sources?.length) || file.note?.preservedSources) && (
        <section className={styles.sources}>
          <h3>{t('sources')}</h3>
          {file.note?.preservedSources ? (
            <pre className={styles.raw}>{file.note.preservedSources}</pre>
          ) : (
            <ul>
              {note?.sources?.map((source, i) => (
                <Source key={i} raw={source} t={t} openSession={openSession} />
              ))}
            </ul>
          )}
        </section>
      )}
      <div className={styles.locationDetail}>
        <span className={styles.hint}>{t('currentLocation')}</span>
        <code className={styles.path}>{displayPath(file.path, scope)}</code>
        <div className={styles.row}>
          <Button
            size="sm"
            onClick={() =>
              void copyMemoryText(displayPath(file.path, scope)).then(
                () => setFeedback(t('copyDone')),
                () => setFeedback(t('copyFailed')),
              )
            }
          >
            {t('copyPath')}
          </Button>
          <span className={styles.hint} role="status">
            {feedback}
          </span>
        </div>
      </div>
    </div>
  );
}
