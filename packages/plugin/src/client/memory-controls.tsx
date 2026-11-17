import { useState } from 'react';
import type { ReactNode } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives/src/Button.tsx';
import { Menu } from '@deepseek-ai/dsh-client-ui-primitives/src/Menu.tsx';
import { IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/src/icons/index.tsx';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { LocaleKey } from './locales.ts';
import styles from './MemoryPanel.module.css';
import { sourceSession } from './memory-state.ts';

export { Button };
export { Input } from '@deepseek-ai/dsh-client-ui-primitives/src/Input.tsx';
export { Switch } from '@deepseek-ai/dsh-client-ui-primitives/src/Switch.tsx';
export { Modal } from '@deepseek-ai/dsh-client-ui-primitives/src/Modal.tsx';
export { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives/src/SegmentedTabs.tsx';
export type Translate = (key: LocaleKey) => string;

export function Choice({
  label,
  value,
  options,
  onChange,
  disabled = false,
  side = 'bottom',
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  side?: 'top' | 'bottom';
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu
      portal
      autoFocus
      side={side}
      minWidthFromAnchor
      open={open && !disabled}
      onClose={() => setOpen(false)}
      selectedId={value}
      items={options}
      onSelect={(id) => {
        setOpen(false);
        onChange(id);
      }}
      className={styles.choice}
      anchor={
        <Button
          variant="outline"
          disabled={disabled}
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          className={styles.choiceButton}
          onClick={() => setOpen(!open)}
        >
          <span>{options.find((option) => option.id === value)?.label ?? value}</span>
          <IconChevronDownOutlineRegular />
        </Button>
      }
    />
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className={styles.field} data-invalid={Boolean(error)}>
      <div className={styles.fieldLabel}>{label}</div>
      {children}
      {hint && <p className={styles.hint}>{hint}</p>}
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function Markdown({
  text,
  t,
  openSession,
}: {
  text: string;
  t: Translate;
  openSession?: ((id: string) => void) | undefined;
}) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        skipHtml
        remarkPlugins={[remarkGfm]}
        remarkRehypeOptions={{ footnoteLabel: t('footnotes') }}
        urlTransform={(url) => (sourceSession(url) ? url : defaultUrlTransform(url))}
        components={{
          a: ({ children, href }) =>
            sourceSession(href ?? '') ? (
              openSession ? (
                <button
                  className={styles.inlineLink}
                  title={href}
                  onClick={() => openSession(sourceSession(href!)!)}
                >
                  {children}
                </button>
              ) : (
                <span title={href}>{children}</span>
              )
            ) : (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
