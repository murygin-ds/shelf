import { useState } from 'react';

import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './profile.module.css';

/**
 * The account, as opposed to the vault: who is signed in here, which key this device is
 * holding, and the two verbs that end a session — one that drops the keys and one that
 * drops the session with them.
 *
 * Everything on it is already in memory. Nothing is fetched, because nothing the server
 * could add about an account is readable to it anyway.
 */
export function ProfileView() {
  const { user, identity, status, signOut, lock } = useSession();
  const { vaults, setView } = useWorkspace();
  const [copied, setCopied] = useState(false);

  const name = user?.display_name ?? '';
  const initials =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?';

  const owned = vaults.filter((vault) => vault.role === 'owner').length;
  const joined = vaults.length - owned;

  const copyFingerprint = () => {
    if (!identity) return;

    void navigator.clipboard?.writeText(identity.fingerprint).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <span className={styles.title}>PROFILE</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.back} onClick={() => setView('editor')}>
          <Icon name="arrow" size={12} />
          Back to notes
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.identity}>
          <span className={styles.avatar}>{initials}</span>
          <div className={styles.identityText}>
            <div className={styles.name}>{name}</div>
            <div className={styles.login}>{user?.login}</div>
          </div>
        </div>

        <div className={styles.section}>ACCOUNT</div>
        <dl className={styles.facts}>
          <Fact label="Display name" value={name} />
          <Fact label="Login" value={user?.login ?? '—'} />
          <Fact
            label="Member since"
            value={user ? new Date(user.created_at).toLocaleDateString() : '—'}
          />
          <Fact
            label="Vaults"
            value={`${owned} own${joined ? ` · ${joined} shared with you` : ''}`}
          />
        </dl>

        <div className={styles.section}>KEYS</div>
        <dl className={styles.facts}>
          <Fact
            label="This device"
            value={status === 'unlocked' ? 'Key unlocked' : 'Key locked'}
          />
          <div className={styles.fact}>
            <dt className={styles.factLabel}>Key fingerprint</dt>
            <dd className={styles.factValue}>
              {/* The server hands out public keys, so it can hand out its own. Comparing this
                  with somebody out of band is what closes that gap — hence a copy button. */}
              <span className={styles.fingerprint}>{identity?.fingerprint ?? '—'}</span>
              {identity ? (
                <button type="button" className={styles.copy} onClick={copyFingerprint}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
              ) : null}
            </dd>
          </div>
        </dl>

        <p className={styles.note}>
          Your passphrase never leaves this device: it unwraps the master key here, and the
          server only ever holds the wrapped copy.
        </p>

        <div className={styles.actions}>
          <button type="button" className={styles.action} onClick={lock}>
            <Icon name="lock" size={13} />
            Lock keys
          </button>
          <button
            type="button"
            className={`${styles.action} ${styles.destructive}`}
            onClick={() => void signOut()}
          >
            <Icon name="arrow" size={13} />
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.fact}>
      <dt className={styles.factLabel}>{label}</dt>
      <dd className={styles.factValue}>{value}</dd>
    </div>
  );
}
