import { type FormEvent, useEffect, useRef, useState } from 'react';

import { m } from '@/i18n';
import { useSession } from '@/store/session';
import { useDismiss } from '@/ui/dismiss';

import styles from './profile.module.css';

/**
 * The last gate in front of an account deletion.
 *
 * Two proofs, because they answer different questions. Typing the login out is what turns a
 * misplaced click into a no-op — nobody types their own address by accident. The passphrase
 * is what says the person at the keyboard is the owner and not whoever found the laptop
 * unlocked; it is checked by the server, which is the only party that can refuse.
 */
export function DeleteAccountDialog({ login, onClose }: { login: string; onClose: () => void }) {
  const { deleteAccount, busy } = useSession();
  const [typed, setTyped] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const dismiss = useDismiss(onClose);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    field.current?.focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ready = typed.trim() === login && passphrase.length > 0 && !busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;

    setError(null);

    // Nothing follows a success here: the session is gone, and the router lands on the sign-in
    // screen the moment the state says so.
    void deleteAccount(passphrase).catch(() =>
      setError(useSession.getState().error ?? m.views.profile.deleteFailed),
    );
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <form
        className={styles.dialog}
        onSubmit={submit}
        role="alertdialog"
        aria-label={m.views.profile.deleteAccount}
      >
        <h2 className={styles.dialogTitle}>{m.views.profile.deleteTitle}</h2>
        <p className={styles.dialogBody}>{m.views.profile.deleteBody}</p>

        <label className={styles.dialogLabel} htmlFor="delete-confirm-login">
          {/* The shared phrase `ui/Confirm.tsx` asks with: same question, same word order. */}
          {m.uiRich.typeToConfirm(<span className={styles.dialogPhrase}>{login}</span>)}
        </label>
        <input
          ref={field}
          id="delete-confirm-login"
          className={styles.dialogInput}
          value={typed}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setTyped(event.target.value)}
        />

        <label className={styles.dialogLabel} htmlFor="delete-confirm-passphrase">
          {m.views.profile.confirmPassphrase}
        </label>
        <input
          id="delete-confirm-passphrase"
          className={styles.dialogInput}
          type="password"
          value={passphrase}
          autoComplete="current-password"
          onChange={(event) => setPassphrase(event.target.value)}
        />

        {error ? <p className={styles.dialogError}>{error}</p> : null}

        <div className={styles.dialogActions}>
          <button type="button" className={styles.dialogCancel} onClick={onClose}>
            {m.common.cancel}
          </button>
          <button type="submit" className={styles.dialogDestroy} disabled={!ready}>
            {busy ? m.views.profile.deleting : m.views.profile.deleteAccount}
          </button>
        </div>
      </form>
    </div>
  );
}
