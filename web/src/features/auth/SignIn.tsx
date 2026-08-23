import { type FormEvent, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';

import { m } from '@/i18n';
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
  const location = useLocation();
  const { status, knownLogin, busy, error, signIn, unlock, signOut, clearError } = useSession();

  const locked = status === 'locked';
  // Set by the guard that sent the user here: a reload on a note comes back to that note.
  const from = (location.state as { from?: string } | null)?.from ?? '/';
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
      navigate(from, { replace: true });
    } catch {
      // The store already turned it into a message; the passphrase stays for a retry.
    }
  };

  return (
    <AuthLayout
      footer={
        locked ? (
          <span>
            {m.authRich.notYou(
              <button type="button" className={styles.footerAction} onClick={() => void signOut()}>
                {m.auth.signIn.signOut}
              </button>,
            )}
          </span>
        ) : (
          <span>
            {m.authRich.noAccount(
              <Link className={styles.footerAction} to="/signup" onClick={clearError}>
                {m.auth.signIn.createOne}
              </Link>,
            )}
          </span>
        )
      }
    >
      <h1 className={styles.title}>{m.auth.signIn.title}</h1>
      <p className={styles.lede}>{m.auth.signIn.lede}</p>

      <form className={styles.form} onSubmit={submit}>
        <Field label={m.auth.fields.email}>
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
          label={m.auth.fields.passphrase}
          action={
            <Link className={styles.link} to="/recover" onClick={clearError}>
              {m.auth.signIn.lost}
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
          {busy ? m.auth.signIn.busy : m.auth.signIn.submit}
        </button>
      </form>
    </AuthLayout>
  );
}
