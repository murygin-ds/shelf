import type { ReactNode } from 'react';

import { Icon } from '@/ui/Icon';

import styles from './auth.module.css';

/** The host the vaults live on, shown wherever the design prints NOTES.ACME.DEV. */
export function origin(): string {
  return window.location.host.toUpperCase();
}

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
        <div className={styles.brand}>
          <span className={styles.mark} />
          <span className={styles.wordmark}>Shelf</span>
          {step ? <span className={styles.step}>{step}</span> : null}
        </div>

        <div className={styles.card}>{children}</div>

        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function Origin() {
  return (
    <span className={styles.origin}>
      <Icon name="lock" size={11} />
      {origin()}
    </span>
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
