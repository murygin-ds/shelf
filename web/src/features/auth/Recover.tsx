import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

import { isRecoveryCodeShaped } from '@/crypto/recovery';
import { m } from '@/i18n';
import { isAcceptable } from '@/lib/passphrase';
import { useSession } from '@/store/session';
import { Icon } from '@/ui/Icon';

import { AuthLayout, ErrorNote, Field } from './AuthLayout';
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
        <span>
          {m.authRich.rememberedIt(
            <Link className={styles.footerAction} to="/signin" onClick={clearError}>
              {m.auth.recover.signInLink}
            </Link>,
          )}
        </span>
      }
    >
      {step === 1 ? (
        <>
          <h1 className={styles.title}>{m.auth.recover.identifyTitle}</h1>
          <p className={styles.lede}>{m.auth.recover.identifyLede}</p>

          <form className={styles.form} onSubmit={identify}>
            <Field label={m.auth.fields.email}>
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

            <Field label={m.auth.fields.recoveryCode}>
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
              {m.auth.recover.continue}
            </button>
          </form>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <h1 className={styles.title}>{m.auth.recover.resetTitle}</h1>
          <p className={styles.lede}>{m.auth.recover.resetLede}</p>

          <form className={styles.form} onSubmit={reset}>
            <Field label={m.auth.fields.newPassphrase}>
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
              <div className={styles.noticeBody}>{m.auth.recover.notice}</div>
            </div>

            <ErrorNote message={error} />

            <button
              className={styles.primary}
              type="submit"
              disabled={busy || !isAcceptable(passphrase)}
            >
              {busy ? m.auth.recover.busy : m.auth.recover.submit}
            </button>
            <button
              className={styles.secondary}
              type="button"
              onClick={() => setStep(1)}
              disabled={busy}
            >
              {m.common.back}
            </button>
          </form>
        </>
      ) : null}
    </AuthLayout>
  );
}
