import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useSession } from '@/store/session';

import { AuthLayout, ErrorNote, Field } from './AuthLayout';
import styles from './auth.module.css';

/**
 * Doubles as the unlock screen. A reload keeps the refresh token but not the master key,
 * so a returning user is "locked" rather than signed out: the login is already known and
 * only the passphrase is asked for.
 */
export function SignIn() {
  const navigate = useNavigate();
  const { status, knownLogin, busy, error, signIn, unlock, signOut, clearError } = useSession();

  const locked = status === 'locked';
  const [login, setLogin] = useState(knownLogin ?? '');
  const [passphrase, setPassphrase] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();

    try {
      if (locked) {
        await unlock(passphrase);
      } else {
        await signIn(login.trim(), passphrase);
      }

      setPassphrase('');
      navigate('/', { replace: true });
    } catch {
      // The store already turned it into a message; the passphrase stays for a retry.
    }
  };

  return (
    <AuthLayout
      footer={
        locked ? (
          <span>
            Not you?{' '}
            <button type="button" className={styles.footerAction} onClick={() => void signOut()}>
              Sign out
            </button>
          </span>
        ) : (
          <span>
            No account?{' '}
            <Link className={styles.footerAction} to="/signup" onClick={clearError}>
              Create one
            </Link>
          </span>
        )
      }
    >
      <h1 className={styles.title}>Unlock your vaults</h1>
      <p className={styles.lede}>Your passphrase decrypts locally. The server never receives it.</p>

      <form className={styles.form} onSubmit={submit}>
        <Field label="EMAIL">
          <input
            className={styles.input}
            type="email"
            autoComplete="username"
            value={locked ? (knownLogin ?? login) : login}
            onChange={(e) => setLogin(e.target.value)}
            disabled={busy || locked}
            required
          />
        </Field>

        <Field
          label="PASSPHRASE"
          action={
            <Link className={styles.link} to="/recover" onClick={clearError}>
              Lost it?
            </Link>
          }
        >
          <input
            className={styles.input}
            type="password"
            autoComplete="current-password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            disabled={busy}
            autoFocus
            required
          />
        </Field>

        <ErrorNote message={error} />

        <button className={styles.primary} type="submit" disabled={busy || passphrase.length === 0}>
          {busy ? 'Deriving keys…' : 'Unlock'}
        </button>
      </form>
    </AuthLayout>
  );
}
