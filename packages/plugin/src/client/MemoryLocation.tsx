import { useState } from 'react';
import { memoryPath } from '@wahhheee/stash-core';
import { Button, Input, Field, Choice } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import styles from './MemoryPanel.module.css';

export function notePath(input: string, scope: 'workspace' | 'session'): string {
  let path = input.trim();
  if (!path || path.endsWith('/') || path.split('/').at(-1) === '.md') throw new Error('name');
  if (path.startsWith('./')) {
    if (scope !== 'session') throw new Error('scope');
    path = path.slice(1);
  } else if (path.startsWith('/') && scope === 'session') throw new Error('scope');
  if (!path.startsWith('/')) path = '/notes/' + path;
  if (!path.endsWith('.md')) path += '.md';
  const result = memoryPath(path, true);
  if (!result.startsWith('/notes/')) throw new Error('scope');
  return result;
}

export function displayPath(path: string, scope: 'workspace' | 'session') {
  return (scope === 'session' ? '.' : '') + path;
}

export function MemoryLocation({
  value,
  onChange,
  scope,
  paths,
  t,
  error,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  scope: 'workspace' | 'session';
  paths: string[];
  t: Translate;
  error?: string | undefined;
  disabled?: boolean;
}) {
  const [manual, setManual] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const relative = value.replace(/^\.?\/notes\//u, '');
  const split = relative.lastIndexOf('/');
  const directory = split < 0 ? '' : relative.slice(0, split + 1);
  const name = relative.slice(split + 1);
  const folders = new Set(['', directory]);
  for (const path of paths) {
    const parts = path.replace(/^\/notes\//u, '').split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/') + '/');
  }
  return (
    <Field label={t('location')} error={error}>
      <div className={styles.row}>
        <span className={styles.scopeBadge}>
          {t(scope === 'session' ? 'currentSession' : 'workspace')}
        </span>
        <Button
          size="sm"
          disabled={disabled}
          onClick={() => {
            setManual(!manual);
            setFolder(null);
          }}
        >
          {t(manual ? 'browseLocation' : 'manualPath')}
        </Button>
      </div>
      {manual ? (
        <>
          <Input
            aria-label={t('path')}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
          />
          <p className={styles.hint}>{t('pathHelp')}</p>
        </>
      ) : (
        <>
          <Choice
            label={t('chooseFolder')}
            value={directory}
            options={[...folders].sort().map((id) => ({
              id,
              label:
                t('notesRoot') + (id ? ' / ' + id.replace(/\/$/u, '').replaceAll('/', ' / ') : ''),
            }))}
            disabled={disabled}
            onChange={(id) => onChange(id + name)}
          />
          <div className={styles.row}>
            <Button
              size="sm"
              disabled={disabled}
              onClick={() => setFolder(folder === null ? '' : null)}
            >
              {t('newFolder')}
            </Button>
          </div>
          {folder !== null && (
            <div className={styles.row}>
              <Input
                aria-label={t('folderName')}
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              />
              <Button
                size="sm"
                disabled={!folder.trim() || /[\\/:*?"<>|]|^\.{1,2}$|[ .]$/u.test(folder)}
                onClick={() => {
                  onChange(directory + folder.trim() + '/' + name);
                  setFolder(null);
                }}
              >
                {t('addFolder')}
              </Button>
            </div>
          )}
          <Field label={t('fileName')}>
            <Input
              aria-label={t('fileName')}
              value={name}
              disabled={disabled}
              onChange={(event) => onChange(directory + event.target.value)}
            />
          </Field>
          <p className={styles.hint}>{t('locationHelp')}</p>
        </>
      )}
    </Field>
  );
}
