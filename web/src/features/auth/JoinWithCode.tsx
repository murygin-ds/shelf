import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { ApiError } from '@/api/client';
import * as collab from '@/api/collab';
import { isInviteCodeShaped } from '@/crypto/invite';
import { usePrefs } from '@/store/prefs';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import { AuthLayout, Field } from './AuthLayout';
import styles from './auth.module.css';

/** Survives the trip through sign-in, so arriving from a link does not lose the code. */
const PARKED_CODE = 'shelf.invite.code';

/**
 * The design's invite screen. Nothing about the vault is visible until the code opens the
 * preview here — the server answers a lookup with ciphertext and an expiry, and nothing else.
 */
export function JoinWithCode() {
  const navigate = useNavigate();
  const { identity, status } = useSession();
  const workspace = useWorkspace();
  const readOnly = usePrefs((state) => state.readOnly);

  const [code, setCode] = useState(() => sessionStorage.getItem(PARKED_CODE) ?? '');
  const [resolved, setResolved] = useState<collab.ResolvedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const resolve = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const found = await collab.resolveInvite(code);

      if (!found) {
        // A code that resolves but will not open the preview is a wrong code. The server
        // cannot tell us which, and deliberately does not try.
        setError('That code does not open anything here.');
        return;
      }

      setResolved(found);
      sessionStorage.setItem(PARKED_CODE, code);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  // Takes the invite it is acting on rather than reading it back out of state: the button
  // only exists in the render where the preview is on screen, so that render is the one
  // source of truth for what is being accepted.
  const accept = async (invite: collab.ResolvedInvite) => {
    // A button that silently does nothing is the worst outcome here, so the one state
    // that can block acceptance says so instead of being ignored.
    if (!identity) {
      setError('Your keys are locked on this device. Unlock them and open this code again.');
      return;
    }

    // The shell hides the way here in read-only, but the route is reachable by its URL, and
    // redeeming a code writes a key grant like any other.
    if (readOnly) {
      setError('Read-only mode is on. Turn it off in the account menu to accept this invite.');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await collab.redeemInvite(code, invite.challenge, identity);
      sessionStorage.removeItem(PARKED_CODE);

      await workspace.load(identity);

      navigate('/', { replace: true });
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const preview = resolved?.preview;

  return (
    <AuthLayout
      wide={Boolean(preview)}
      footer={
        <Link className={styles.footerAction} to="/">
          Back to your vaults
        </Link>
      }
    >
      {!preview ? (
        <>
          <h1 className={styles.title}>Join with a code</h1>
          <p className={styles.lede}>
            Whoever invited you handed you a code. It never reaches the server — it is what
            unwraps the vault key on this device.
          </p>

          <form className={styles.form} onSubmit={resolve}>
            <Field label="INVITE CODE">
              <input
                className={styles.input}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="ABCDE-FGHJK-MNPQR-STVWX-YZ012"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                required
              />
            </Field>

            {error !== null ? (
              <div className={styles.error} role="alert">
                <Icon name="warn" size={14} style={{ flex: 'none', marginTop: 1 }} />
                <span>{error}</span>
              </div>
            ) : null}

            <button
              className={styles.primary}
              type="submit"
              disabled={busy || !isInviteCodeShaped(code)}
            >
              {busy ? 'Checking…' : 'Continue'}
            </button>
          </form>
        </>
      ) : (
        <>
          <h1 className={styles.title}>
            {preview.inviterName || 'Someone'} invited you to{' '}
            <span style={{ color: 'var(--accent)' }}>{preview.vaultName}</span>
          </h1>

          <div
            style={{
              marginTop: 22,
              border: '1px solid var(--border-quiet)',
              borderRadius: 11,
              overflow: 'hidden',
            }}
          >
            <div className={styles.previewRow}>
              <span style={{ color: 'var(--text-dim)' }}>Your role</span>
              <span style={{ flex: 1 }} />
              <span>{preview.role}</span>
            </div>
            <div className={styles.previewRow} style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <span style={{ color: 'var(--text-dim)' }}>Keys in this invite</span>
              <span style={{ flex: 1 }} />
              <span>{resolved.challenge.key_grants.length}</span>
            </div>
          </div>

          <div className={styles.notice} style={{ marginTop: 16 }}>
            <Icon name="key" size={14} className={`${styles.noticeIcon} ${styles.noticeIconOk}`} />
            <div className={styles.noticeBody}>
              Accepting unwraps the vault key with this code and re-seals it to your own key on
              this device. The person who invited you cannot read your key, and the server only
              ever stores the wrapped copy.
            </div>
          </div>

          {error !== null ? (
            <div className={styles.error} style={{ marginTop: 14 }} role="alert">
              <Icon name="warn" size={14} style={{ flex: 'none', marginTop: 1 }} />
              <span>{error}</span>
            </div>
          ) : null}

          {!identity ? (
            <div className={styles.notice} style={{ marginTop: 14 }}>
              <Icon name="lock" size={14} className={styles.noticeIcon} />
              <div className={styles.noticeBody}>
                The invite is re-sealed to a key only you hold, so you need one first. The code
                is kept while you go.
                <span style={{ display: 'flex', gap: 14, marginTop: 8 }}>
                  <Link className={styles.footerAction} to="/signin">
                    {status === 'locked' ? 'Unlock' : 'Sign in'}
                  </Link>
                  {status === 'anonymous' ? (
                    <Link className={styles.footerAction} to="/signup">
                      Create an account
                    </Link>
                  ) : null}
                </span>
              </div>
            </div>
          ) : null}

          <div style={{ display: 'flex', gap: 9, marginTop: 18 }}>
            <button
              className={styles.primary}
              style={{ flex: 1, marginTop: 0 }}
              type="button"
              onClick={() => void accept(resolved)}
              disabled={busy || !identity}
            >
              {busy ? 'Re-sealing keys…' : 'Accept & unlock'}
            </button>
            <button
              className={styles.secondary}
              style={{ padding: '0 18px' }}
              type="button"
              onClick={() => {
                setResolved(null);
                setCode('');
              }}
              disabled={busy}
            >
              Decline
            </button>
          </div>
        </>
      )}
    </AuthLayout>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 404) return 'That code does not open anything here.';
    if (cause.status === 409) return 'You are already a member of this vault.';
    if (cause.status === 429) return 'Too many attempts. Try again in a few minutes.';

    // A server that answers without a message would otherwise produce an empty banner,
    // which reads as nothing having happened at all.
    return cause.message || `The server refused this (HTTP ${cause.status}).`;
  }

  if (cause instanceof Error) return cause.message || cause.name;

  return 'Something went wrong.';
}
