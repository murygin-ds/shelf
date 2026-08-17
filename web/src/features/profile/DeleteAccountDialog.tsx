import { type FormEvent, useEffect, useRef, useState } from 'react';

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
      setError(useSession.getState().error ?? 'Could not delete the account.'),
    );
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <form className={styles.dialog} onSubmit={submit} role="alertdialog" aria-label="Delete account">
        <h2 className={styles.dialogTitle}>Delete your account?</h2>
        <p className={styles.dialogBody}>
          This destroys your account, every vault you own and everything in them, for all of
          their members. The server keeps only ciphertext and deletes it; no key anyone kept
          will bring it back. Notes you wrote in somebody else’s vault stay with that vault.
        </p>

        <label className={styles.dialogLabel} htmlFor="delete-confirm-login">
          Type <span className={styles.dialogPhrase}>{login}</span> to confirm
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
          Confirm with your passphrase
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
            Cancel
          </button>
          <button type="submit" className={styles.dialogDestroy} disabled={!ready}>
            {busy ? 'Deleting…' : 'Delete account'}
          </button>
        </div>
      </form>
    </div>
  );
}
