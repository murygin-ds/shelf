import type { ReactNode } from 'react';

import { Icon } from '@/ui/Icon';

import styles from './auth.module.css';

/** The host the vaults live on. Only the downloadable recovery kit names it. */
export function origin(): string {
  return window.location.host.toUpperCase();
}

/**
 * One card and nothing beside it. Everything the screen has to say — the step counter, the
 * way out to the other screen — lives inside the card, so the page is a single object
 * rather than a card with loose text floating around it.
 */
export function AuthLayout({
  children,
  footer,
  step,
  wide = false,
}: {
  children: ReactNode;
  footer?: ReactNode;
  step?: string | undefined;
  wide?: boolean;
}) {
  return (
    <div className={styles.screen}>
      <div className={`${styles.column} ${wide ? styles.wide : ''}`}>
        <div className={styles.card}>
          {step ? <div className={styles.step}>{step}</div> : null}

          {children}

          {footer ? <div className={styles.footer}>{footer}</div> : null}
        </div>
      </div>
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <div className={styles.error} role="alert">
      <Icon name="warn" size={14} style={{ flex: 'none', marginTop: 1 }} />
      <span>{message}</span>
    </div>
  );
}

export function Field({
  label,
  action,
  children,
}: {
  label: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className={styles.field}>
      <span className={styles.fieldHead}>
        <span className={styles.fieldLabel}>{label}</span>
        {action}
      </span>
      {children}
    </label>
  );
}
