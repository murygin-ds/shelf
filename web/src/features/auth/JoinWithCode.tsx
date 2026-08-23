import { type FormEvent, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import * as collab from '@/api/collab';
import { describe } from '@/api/errors';
import { isInviteCodeShaped } from '@/crypto/invite';
import { m, roleLabel } from '@/i18n';
import { usePrefs } from '@/store/prefs';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import { AuthLayout, Field } from './AuthLayout';
import styles from './auth.module.css';

/** Survives the trip through sign-in, so arriving from a link does not lose the code. */
const PARKED_CODE = 'shelf.invite.code';

/**
 * The preview is decrypted ciphertext, so its role is a `string` and not a `Role`: a
 * narrowing rather than a cast, and anything unrecognised is shown as it came.
 */
function roleName(role: string): string {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'editor':
    case 'viewer':
      return roleLabel(role);
    default:
      return role;
  }
}

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
        setError(m.auth.join.wrongCode);
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
      setError(m.auth.join.locked);
      return;
    }

    // The shell hides the way here in read-only, but the route is reachable by its URL, and
    // redeeming a code writes a key grant like any other.
    if (readOnly) {
      setError(m.auth.join.readOnly);
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
          {m.auth.join.back}
        </Link>
      }
    >
      {!preview ? (
        <>
          <h1 className={styles.title}>{m.auth.join.title}</h1>
          <p className={styles.lede}>{m.auth.join.lede}</p>

          <form className={styles.form} onSubmit={resolve}>
            <Field label={m.auth.fields.inviteCode}>
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
              {busy ? m.auth.join.busy : m.auth.join.submit}
            </button>
          </form>
        </>
      ) : (
        <>
          <h1 className={styles.title}>
            {m.authRich.invitedYou(
              preview.inviterName || m.auth.join.someone,
              <span style={{ color: 'var(--accent)' }}>{preview.vaultName}</span>,
            )}
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
              <span style={{ color: 'var(--text-dim)' }}>{m.auth.join.role}</span>
              <span style={{ flex: 1 }} />
              <span>{roleName(preview.role)}</span>
            </div>
            <div className={styles.previewRow} style={{ borderTop: '1px solid var(--border-subtle)' }}>
              <span style={{ color: 'var(--text-dim)' }}>{m.auth.join.keys}</span>
              <span style={{ flex: 1 }} />
              <span>{resolved.challenge.key_grants.length}</span>
            </div>
          </div>

          <div className={styles.notice} style={{ marginTop: 16 }}>
            <Icon name="key" size={14} className={`${styles.noticeIcon} ${styles.noticeIconOk}`} />
            <div className={styles.noticeBody}>{m.auth.join.notice}</div>
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
                {m.auth.join.lockedNotice}
                <span style={{ display: 'flex', gap: 14, marginTop: 8 }}>
                  <Link className={styles.footerAction} to="/signin">
                    {status === 'locked' ? m.auth.join.unlock : m.auth.join.signIn}
                  </Link>
                  {status === 'anonymous' ? (
                    <Link className={styles.footerAction} to="/signup">
                      {m.auth.join.createAccount}
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
              {busy ? m.auth.join.acceptBusy : m.auth.join.accept}
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
              {m.auth.join.decline}
            </button>
          </div>
        </>
      )}
    </AuthLayout>
  );
}
