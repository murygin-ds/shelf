import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';

import { m } from '@/i18n';
import { isAcceptable } from '@/lib/passphrase';
import { useSession } from '@/store/session';
import { Icon } from '@/ui/Icon';

import { AuthLayout, ErrorNote, Field } from './AuthLayout';
import { PassphraseMeter } from './PassphraseMeter';
import styles from './auth.module.css';

type Step = 1 | 2;

export function SignUp() {
  const { busy, error, register, clearError } = useSession();

  const [step, setStep] = useState<Step>(1);
  const [displayName, setDisplayName] = useState('');
  const [login, setLogin] = useState('');
  const [passphrase, setPassphrase] = useState('');

  // Step 1 never leaves the browser: nothing is sent until the passphrase exists, because
  // the account and its keys are created in a single request.
  const identify = (event: FormEvent) => {
    event.preventDefault();
    clearError();
    setStep(2);
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();

    try {
      // On success the session enters the "kit" state and the route guard takes over.
      await register({ login: login.trim(), displayName: displayName.trim(), passphrase });
      setPassphrase('');
    } catch {
      // Stay on step 2 with the message the store produced.
    }
  };

  return (
    <AuthLayout
      step={m.auth.signUp.step(step, 2)}
      footer={
        <span>
          {m.authRich.haveAccount(
            <Link className={styles.footerAction} to="/signin" onClick={clearError}>
              {m.auth.signUp.signInLink}
            </Link>,
          )}
        </span>
      }
    >
      {step === 1 ? (
        <>
          <h1 className={styles.title}>{m.auth.signUp.identifyTitle}</h1>
          <p className={styles.lede}>{m.auth.signUp.identifyLede}</p>

          <form className={styles.form} onSubmit={identify}>
            <Field label={m.auth.fields.name}>
              <input
                className={styles.input}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name"
                maxLength={128}
                autoFocus
                required
              />
            </Field>

            <Field label={m.auth.fields.workEmail}>
              <input
                className={styles.input}
                type="email"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                minLength={3}
                maxLength={64}
                required
              />
            </Field>

            <button className={styles.primary} type="submit">
              {m.auth.signUp.continue}
            </button>
          </form>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <h1 className={styles.title}>{m.auth.signUp.passphraseTitle}</h1>
          <p className={styles.lede}>{m.auth.signUp.passphraseLede}</p>

          <form className={styles.form} onSubmit={create}>
            <Field label={m.auth.fields.passphrase}>
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
              <Icon name="key" size={14} className={styles.noticeIcon} />
              <div className={styles.noticeBody}>
                <span className={styles.noticeLabel}>{m.auth.zeroKnowledge}</span>
                {m.auth.signUp.warning}
              </div>
            </div>

            <ErrorNote message={error} />

            <button
              className={styles.primary}
              type="submit"
              disabled={busy || !isAcceptable(passphrase)}
            >
              {busy ? m.auth.signUp.busy : m.auth.signUp.submit}
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
