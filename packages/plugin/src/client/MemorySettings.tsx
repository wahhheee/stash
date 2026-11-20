import { useState } from 'react';
import { resolveSwitches } from '@wahhheee/stash-core';
import type { SwitchRecord } from '@wahhheee/stash-core';
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx';
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx';
import { IconWarningTriangleOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx';
import { Button, Choice, Switch } from './memory-controls.tsx';
import type { Translate } from './memory-controls.tsx';
import type { MemoryPageData } from '../page-types.ts';
import type { MemoryScope } from './memory-state.ts';
import styles from './MemoryPanel.module.css';
import { StashIcon } from './StashIcon.tsx';

function options(
  data: MemoryPageData,
  scope: MemoryScope,
  key: 'enabled' | 'writable',
  t: Translate,
) {
  const parent =
    scope === 'session'
      ? resolveSwitches(data.globalEnabled, data.workspace)[key]
      : data.globalEnabled;
  return [
    {
      id: 'inherit',
      label:
        t(scope === 'session' ? 'followWorkspace' : 'followGlobal') +
        ' · ' +
        t(parent ? 'on' : 'off'),
    },
    { id: 'true', label: t('on') },
    { id: 'false', label: t('off') },
  ];
}

export function MemorySettings({
  data,
  scope,
  pending,
  update,
  clear,
  t,
}: {
  data: MemoryPageData;
  scope: MemoryScope;
  pending: boolean;
  update: (value: SwitchRecord) => void;
  clear: () => void;
  t: Translate;
}) {
  const value = data[scope];
  const effective =
    scope === 'workspace' ? resolveSwitches(data.globalEnabled, data.workspace) : data.effective;
  return (
    <div className={styles.settings}>
      <section aria-label={t('switchSettings')} className={styles.switchGroup}>
        <header>
          <h2>{t('switchSettings')}</h2>
          <p className={styles.hint}>{t('changesImmediate')}</p>
        </header>
        {!data.globalEnabled && <p className={styles.notice}>{t('globalOff')}</p>}
        {(['enabled', 'writable'] as const).map((key) => (
          <div key={key} className={styles.settingRow}>
            <div>
              <strong>{t(key)}</strong>
              <p className={styles.hint}>{t(key === 'enabled' ? 'enabledHelp' : 'writableHelp')}</p>
              <span className={styles.hint}>
                {t('effectiveState').replace('{state}', t(effective[key] ? 'on' : 'off'))}
              </span>
            </div>
            <Choice
              label={t(key)}
              disabled={pending || !data.globalEnabled}
              options={options(data, scope, key, t)}
              value={value[key] === null ? 'inherit' : String(value[key])}
              onChange={(id) =>
                update({ ...value, [key]: id === 'inherit' ? null : id === 'true' })
              }
            />
          </div>
        ))}
        {scope === 'session' &&
          (['discoverable', 'inheritWorkspace'] as const).map((key) => (
            <div key={key} className={styles.settingRow}>
              <div>
                <strong>{t(key)}</strong>
                <p className={styles.hint}>
                  {t(key === 'discoverable' ? 'discoverableHelp' : 'inheritWorkspaceHelp')}
                </p>
              </div>
              <Switch
                label={t(key)}
                checked={value[key]}
                disabled={pending || !data.globalEnabled}
                onChange={(checked) => update({ ...value, [key]: checked })}
              />
            </div>
          ))}
      </section>
      <section aria-label={t('danger')} className={styles.dangerZone}>
        <h3>
          <IconWarningTriangleOutlineRegular /> {t('danger')}
        </h3>
        <p className={styles.hint}>
          {t(scope === 'workspace' ? 'clearWorkspaceHint' : 'clearSessionHint')}
        </p>
        <Button
          variant="outline"
          disabled={pending || (scope === 'session' && !data.sessionEditable)}
          onClick={clear}
        >
          {t(scope === 'workspace' ? 'clearWorkspace' : 'clearSession')}
        </Button>
      </section>
    </div>
  );
}

export function QuickMemory({
  data,
  pending,
  update,
  openPage,
  retry,
  message,
  t,
}: {
  data: MemoryPageData | undefined;
  pending: boolean;
  update: (value: SwitchRecord) => void;
  openPage: (() => boolean) | undefined;
  retry: (() => void) | undefined;
  message: string;
  t: Translate;
}) {
  const [open, setOpen] = useState(false);
  const items: MenuEntry[] = [];
  const selected: string[] = [];
  if (data) {
    items.push({
      type: 'label',
      id: 'scope',
      text: t('currentSession') + ' · ' + (data.sessionTitle || t('unnamedSession')),
    });
    for (const key of ['enabled', 'writable'] as const) {
      const choice = data.session[key] === null ? 'inherit' : String(data.session[key]);
      selected.push(key + ':' + choice);
      items.push({
        id: key,
        label: t(key) + ' · ' + t(data.effective[key] ? 'on' : 'off'),
        disabled: pending || !data.globalEnabled,
        submenu: options(data, 'session', key, t).map((item) => ({
          ...item,
          id: key + ':' + item.id,
        })),
      });
    }
    for (const key of ['discoverable', 'inheritWorkspace'] as const) {
      if (data.session[key]) selected.push(key);
      items.push({ id: key, label: t(key), disabled: pending || !data.globalEnabled });
    }
    if (!data.globalEnabled) items.push({ type: 'label', id: 'globalOff', text: t('globalOff') });
  } else items.push({ type: 'label', id: 'loading', text: message || t('loadingMemory') });
  if (message && data) items.push({ type: 'label', id: 'message', text: message });
  if (retry) items.push({ id: 'retry', label: t('retry'), disabled: pending });
  items.push(
    { type: 'separator', id: 'separator' },
    { id: 'open', label: t('memory') + ' · ' + t('preferences'), disabled: !openPage },
  );
  return (
    <>
      <span role="status" className={styles.quickAnnouncement}>
        {message}
      </span>
      <Menu
        open={open}
        portal
        autoFocus
        side="top"
        items={items}
        selectedIds={selected}
        onClose={() => setOpen(false)}
        onSelect={(id) => {
          if (id === 'open') {
            if (openPage?.()) setOpen(false);
          } else if (id === 'retry') retry?.();
          else if (data) {
            if (id === 'discoverable' || id === 'inheritWorkspace')
              update({ ...data.session, [id]: !data.session[id] });
            else {
              const [key, value] = id.split(':');
              if (key === 'enabled' || key === 'writable')
                update({ ...data.session, [key]: value === 'inherit' ? null : value === 'true' });
            }
          }
        }}
        anchor={
          <Button
            size="sm"
            variant="ghost"
            icon={<StashIcon />}
            aria-label={'stash · ' + t('memory')}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            stash{' '}
            <span className={styles.quickState}>
              {data ? t(data.effective.enabled ? 'on' : 'off') : '…'}
            </span>
          </Button>
        }
      />
    </>
  );
}
