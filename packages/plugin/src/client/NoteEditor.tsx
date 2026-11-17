import { useState } from 'react';
import type { NoteForm, NoteProjection } from '@wahhheee/stash-core';
import { Button, Choice, Field, Input, Markdown, Switch } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import { joinSource, splitSource } from './memory-state.ts';
import { MemoryLocation, displayPath } from './MemoryLocation.tsx';
import type { MemoryScope } from './memory-state.ts';
import styles from './MemoryPanel.module.css';

export const noteTypes = ['fact', 'lesson', 'decision', 'context', 'reference'] as const;

const typeKeys = {
  fact: 'typeFact',
  lesson: 'typeLesson',
  decision: 'typeDecision',
  context: 'typeContext',
  reference: 'typeReference',
} as const;

export function typeName(type: string, t: Translate) {
  return type in typeKeys ? t(typeKeys[type as keyof typeof typeKeys]) : type;
}

export function NoteEditor({
  value,
  onChange,
  location,
  onLocation,
  isNew,
  scope,
  paths,
  projection,
  errors,
  disabled,
  t,
}: {
  value: NoteForm;
  onChange: (value: NoteForm) => void;
  location: string;
  onLocation: (path: string) => void;
  isNew: boolean;
  scope: MemoryScope;
  paths: string[];
  projection?: NoteProjection | null | undefined;
  errors: Record<string, string>;
  disabled: boolean;
  t: Translate;
}) {
  const [custom, setCustom] = useState(!noteTypes.some((type) => type === value.type));
  const [preview, setPreview] = useState(false);
  const update = (patch: Partial<NoteForm>) => onChange({ ...value, ...patch });
  return (
    <div className={styles.editor}>
      <Field label={t('typeLabel')} error={errors.type}>
        <Choice
          label={t('typeLabel')}
          value={custom ? 'custom' : value.type}
          disabled={disabled}
          options={[
            ...noteTypes.map((id) => ({ id, label: typeName(id, t) })),
            { id: 'custom', label: t('typeCustom') },
          ]}
          onChange={(id) => {
            setCustom(id === 'custom');
            update({ type: id === 'custom' ? '' : id });
          }}
        />
        {custom && (
          <Input
            aria-label={t('customType')}
            value={value.type}
            disabled={disabled}
            onChange={(event) => update({ type: event.target.value })}
          />
        )}
      </Field>
      <Field label={t('noteDescription')} hint={t('descriptionHelp')} error={errors.description}>
        <textarea
          rows={3}
          aria-label={t('noteDescription')}
          aria-invalid={Boolean(errors.description)}
          placeholder={t('descriptionExample')}
          value={value.description}
          disabled={disabled}
          onChange={(event) => update({ description: event.target.value })}
        />
      </Field>
      <Field label={t('content')} hint={t('bodyHelp')} error={errors.body}>
        <div className={styles.row}>
          <Button size="sm" aria-pressed={!preview} onClick={() => setPreview(false)}>
            {t('write')}
          </Button>
          <Button size="sm" aria-pressed={preview} onClick={() => setPreview(true)}>
            {t('preview')}
          </Button>
        </div>
        {preview ? (
          <div className={styles.bodyPreview}>
            <Markdown text={value.body} t={t} />
          </div>
        ) : (
          <textarea
            className={styles.bodyEditor}
            aria-label={t('content')}
            value={value.body}
            disabled={disabled}
            onChange={(event) => update({ body: event.target.value })}
          />
        )}
      </Field>
      <Field label={t('sources')} hint={t('sourceHelp')} error={errors.sources}>
        {projection?.preservedSources ? (
          <>
            <p className={styles.hint}>{t('preservedSources')}</p>
            <pre className={styles.raw}>{projection.preservedSources}</pre>
          </>
        ) : (
          <>
            {value.sources?.map((raw, index) => {
              const source = splitSource(raw);
              const edit = (name: string, target: string) =>
                update({
                  sources: value.sources!.map((item, i) =>
                    i === index ? joinSource(name, target) : item,
                  ),
                });
              return (
                <div key={index} className={styles.sourceEditor}>
                  <Input
                    aria-label={t('sourceName') + ' ' + (index + 1)}
                    value={source.name}
                    placeholder={t('sourceName')}
                    disabled={disabled}
                    onChange={(event) => edit(event.target.value, source.target)}
                  />
                  <Input
                    aria-label={t('sourceTarget') + ' ' + (index + 1)}
                    value={source.target}
                    placeholder={t('sourceTarget')}
                    disabled={disabled}
                    onChange={(event) => edit(source.name, event.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={disabled}
                    onClick={() =>
                      update({ sources: value.sources!.filter((_, i) => i !== index) })
                    }
                  >
                    {t('removeSource')}
                  </Button>
                </div>
              );
            })}
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => update({ sources: [...(value.sources ?? []), ''] })}
            >
              {t('addSource')}
            </Button>
          </>
        )}
      </Field>
      <div className={styles.settingRow}>
        <div>
          <strong>{t('includeIndex')}</strong>
          <p className={styles.hint}>{t('includeIndexHelp')}</p>
        </div>
        <Switch
          label={t('includeIndex')}
          checked={value.index}
          disabled={disabled}
          onChange={(index) => update({ index })}
        />
      </div>
      <div className={styles.settingRow}>
        <div>
          <strong>{t('archived')}</strong>
          <p className={styles.hint}>{t('archivedHelp')}</p>
        </div>
        <Switch
          label={t('archived')}
          checked={value.status === 'archived'}
          disabled={disabled}
          onChange={(archived) => update({ status: archived ? 'archived' : null })}
        />
      </div>
      {value.status !== null && value.status !== 'archived' && (
        <Field label={t('customStatus')}>
          <Input
            aria-label={t('customStatus')}
            value={value.status}
            disabled={disabled}
            onChange={(event) => update({ status: event.target.value || null })}
          />
        </Field>
      )}
      {isNew ? (
        <MemoryLocation
          value={location}
          onChange={onLocation}
          scope={scope}
          paths={paths}
          disabled={disabled}
          t={t}
          error={errors.path}
        />
      ) : (
        <Field label={t('currentLocation')}>
          <code className={styles.path}>{displayPath(location, scope)}</code>
        </Field>
      )}
      {Boolean(projection?.additionalFields.length) && (
        <p className={styles.hint}>
          {t('extraMetadata')} {projection!.additionalFields.join(', ')}
        </p>
      )}
    </div>
  );
}
