import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

import { isRecoveryCodeShaped } from '@/crypto/recovery';
import { isAcceptable } from '@/lib/passphrase';
import { useSession } from '@/store/session';
import { Icon } from '@/ui/Icon';

import { AuthLayout, ErrorNote, Field, Origin } from './AuthLayout';
import { PassphraseMeter } from './PassphraseMeter';
import styles from './auth.module.css';

type Step = 1 | 2;

/**
 * Recovery unwraps the master key with the recovery code and re-wraps it with a key from
 * the new passphrase. The master key itself is unchanged, so every note stays readable
 * and the identity keypairs survive.
 */
export function Recover() {
  const { busy, error, recover, clearError } = useSession();

  const [step, setStep] = useState<Step>(1);
  const [login, setLogin] = useState('');
  const [code, setCode] = useState('');
  const [passphrase, setPassphrase] = useState('');

  const identify = (event: FormEvent) => {
    event.preventDefault();
    clearError();
    setStep(2);
  };

  const reset = async (event: FormEvent) => {
    event.preventDefault();

    try {
      // The code proves ownership and the new credentials land in the same exchange, so a
      // half-finished recovery cannot leave an account with neither passphrase working.
      // On success the route guard hands over to the new recovery kit.
      await recover(login.trim(), code, passphrase);
      setCode('');
      setPassphrase('');
    } catch {
      // Stay on step 2 with the message the store produced.
    }
  };

  return (
    <AuthLayout
      footer={
        <>
          <span>
            Remembered it?{' '}
            <Link className={styles.footerAction} to="/signin" onClick={clearError}>
              Sign in
            </Link>
          </span>
          <Origin />
        </>
      }
    >
      {step === 1 ? (
        <>
          <h1 className={styles.title}>Use your recovery kit</h1>
          <p className={styles.lede}>
            The code from your kit unwraps your master key on this device. The server checks a
            separate verifier and never sees the code itself.
          </p>

          <form className={styles.form} onSubmit={identify}>
            <Field label="EMAIL">
              <input
                className={styles.input}
                type="email"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                autoFocus
                required
              />
            </Field>

            <Field label="RECOVERY CODE">
              <input
                className={styles.input}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="ABCDE-FGHJK-MNPQR-STVWX-YZ012"
                spellCheck={false}
                autoComplete="off"
                required
              />
            </Field>

            <button
              className={styles.primary}
              type="submit"
              disabled={!isRecoveryCodeShaped(code) || login.trim().length < 3}
            >
              Continue
            </button>
          </form>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <h1 className={styles.title}>Choose a new passphrase</h1>
          <p className={styles.lede}>
            Your notes stay as they are — only the key that wraps your master key changes.
          </p>

          <form className={styles.form} onSubmit={reset}>
            <Field label="NEW PASSPHRASE">
              <input
                className={styles.input}
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoComplete="new-password"
                autoFocus
                required
              />
              <PassphraseMeter value={passphrase} />
            </Field>

            <div className={styles.notice}>
              <Icon name="shield" size={14} className={`${styles.noticeIcon} ${styles.noticeIconOk}`} />
              <div className={styles.noticeBody}>
                Every existing session is signed out, and the recovery code you just used stops
                working. A new kit is issued on the next screen.
              </div>
            </div>

            <ErrorNote message={error} />

            <button
              className={styles.primary}
              type="submit"
              disabled={busy || !isAcceptable(passphrase)}
            >
              {busy ? 'Re-wrapping your keys…' : 'Reset passphrase'}
            </button>
            <button
              className={styles.secondary}
              type="button"
              onClick={() => setStep(1)}
              disabled={busy}
            >
              Back
            </button>
          </form>
        </>
      ) : null}
    </AuthLayout>
  );
}
