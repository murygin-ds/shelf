import { type FormEvent, useState } from 'react';

import { PassphraseMeter } from '@/features/auth/PassphraseMeter';
import { format, m } from '@/i18n';
import { isAcceptable, MIN_PASSPHRASE_LENGTH } from '@/lib/passphrase';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import { DeleteAccountDialog } from './DeleteAccountDialog';
import styles from './profile.module.css';

/**
 * The account, as opposed to the vault: who is signed in here, which key this device is
 * holding, and the verbs that act on the account itself rather than on anything in it.
 *
 * The read-only facts are already in memory and are never fetched — nothing the server
 * could add about an account is readable to it anyway. The three that write are ordered by
 * what they cost: a name, then the passphrase every key hangs off, then the one that ends
 * the account, behind its own line.
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
        <span className={styles.title}>{m.views.profile.title}</span>
        <span className={styles.spacer} />
        <button type="button" className={styles.back} onClick={() => setView('editor')}>
          <Icon name="arrow" size={12} />
          {m.views.profile.back}
        </button>
      </div>

      <div className={styles.body}>
        <div className={styles.inner}>
          <div className={styles.identity}>
            <span className={styles.avatar}>{initials}</span>
            <div className={styles.identityText}>
              <div className={styles.name}>{name}</div>
              <div className={styles.login}>{user?.login}</div>
            </div>
          </div>

          <div className={styles.section}>{m.views.profile.account}</div>
          <DisplayNameForm current={name} />
          <dl className={styles.facts}>
            <Fact label={m.views.profile.login} value={user?.login ?? '—'} />
            <Fact
              label={m.views.profile.memberSince}
              value={user ? format.date(user.created_at) : '—'}
            />
            <Fact
              label={m.views.profile.vaults}
              value={
                joined
                  ? m.views.profile.vaultsShared(owned, joined)
                  : m.views.profile.vaultsOwn(owned)
              }
            />
          </dl>

          <div className={styles.section}>{m.views.profile.keys}</div>
          <dl className={styles.facts}>
            <Fact
              label={m.views.profile.thisDevice}
              value={status === 'unlocked' ? m.views.profile.keyUnlocked : m.views.profile.keyLocked}
            />
            <div className={styles.fact}>
              <dt className={styles.factLabel}>{m.views.profile.fingerprint}</dt>
              <dd className={styles.factValue}>
                {/* The server hands out public keys, so it can hand out its own. Comparing this
                    with somebody out of band is what closes that gap — hence a copy button. */}
                <span className={styles.fingerprint}>{identity?.fingerprint ?? '—'}</span>
                {identity ? (
                  <button type="button" className={styles.copy} onClick={copyFingerprint}>
                    {copied ? m.common.copied : m.common.copy}
                  </button>
                ) : null}
              </dd>
            </div>
          </dl>

          <p className={styles.note}>{m.views.profile.keyNote}</p>

          <div className={styles.actions}>
            <button type="button" className={styles.action} onClick={lock}>
              <Icon name="lock" size={13} />
              {m.views.profile.lock}
            </button>
            <button type="button" className={styles.action} onClick={() => void signOut()}>
              <Icon name="arrow" size={13} />
              {m.views.profile.signOut}
            </button>
          </div>

          <div className={styles.section}>{m.views.profile.passphrase}</div>
          <PassphraseForm />

          <div className={styles.section}>{m.views.profile.danger}</div>
          <DangerZone login={user?.login ?? ''} />
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

/**
 * The name other members read on a shared vault. It is also the only thing here the server
 * stores in the clear, which is why it is the only field it can change.
 */
function DisplayNameForm({ current }: { current: string }) {
  const { updateDisplayName, busy } = useSession();
  const [value, setValue] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const trimmed = value.trim();
  const ready = trimmed !== '' && trimmed !== current && !busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;

    setError(null);
    setSaved(false);

    void updateDisplayName(trimmed)
      .then(() => {
        setValue(trimmed);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 2000);
      })
      .catch(() => setError(useSession.getState().error ?? m.views.profile.nameFailed));
  };

  return (
    <form className={styles.field} onSubmit={submit}>
      <label className={styles.fieldLabel} htmlFor="profile-display-name">
        {m.views.profile.displayName}
      </label>
      <div className={styles.fieldRow}>
        <input
          id="profile-display-name"
          className={styles.input}
          value={value}
          maxLength={128}
          spellCheck={false}
          onChange={(event) => setValue(event.target.value)}
        />
        <button type="submit" className={styles.action} disabled={!ready}>
          {saved ? m.common.saved : m.common.save}
        </button>
      </div>
      {error ? <p className={styles.error}>{error}</p> : null}
    </form>
  );
}

/**
 * Changing the passphrase re-wraps the master key on this device and sends the wrap; the
 * key itself never changes, so nothing sealed under it has to be rewritten. Two things
 * follow that are worth saying before the button rather than after: every other device is
 * signed out, and the recovery code is rotated — the kit screen takes over to show the new
 * one once.
 */
function PassphraseForm() {
  const { changePassphrase, busy } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mismatch = repeat.length > 0 && next !== repeat;
  const reused = next.length > 0 && next === current;
  const ready =
    current.length > 0 && isAcceptable(next) && next === repeat && !reused && !busy;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;

    setError(null);

    void changePassphrase(current, next).catch(() =>
      setError(useSession.getState().error ?? m.views.profile.passphraseFailed),
    );
  };

  return (
    <form className={styles.field} onSubmit={submit}>
      <label className={styles.fieldLabel} htmlFor="profile-current-passphrase">
        {m.views.profile.currentPassphrase}
      </label>
      <input
        id="profile-current-passphrase"
        className={styles.input}
        type="password"
        autoComplete="current-password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
      />

      <label className={styles.fieldLabel} htmlFor="profile-new-passphrase">
        {m.views.profile.newPassphrase}
      </label>
      <input
        id="profile-new-passphrase"
        className={styles.input}
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(event) => setNext(event.target.value)}
      />
      <div className={styles.meterRow}>
        <PassphraseMeter value={next} />
      </div>

      <label className={styles.fieldLabel} htmlFor="profile-repeat-passphrase">
        {m.views.profile.repeatPassphrase}
      </label>
      <input
        id="profile-repeat-passphrase"
        className={styles.input}
        type="password"
        autoComplete="new-password"
        value={repeat}
        onChange={(event) => setRepeat(event.target.value)}
      />

      <p className={styles.note}>{m.views.profile.passphraseNote(MIN_PASSPHRASE_LENGTH)}</p>

      {mismatch ? <p className={styles.error}>{m.views.profile.mismatch}</p> : null}
      {reused ? <p className={styles.error}>{m.views.profile.reused}</p> : null}
      {error ? <p className={styles.error}>{error}</p> : null}

      <div className={styles.actions}>
        <button type="submit" className={styles.action} disabled={!ready}>
          {busy ? m.views.profile.changing : m.views.profile.change}
        </button>
      </div>
    </form>
  );
}

function DangerZone({ login }: { login: string }) {
  const [asking, setAsking] = useState(false);

  return (
    <div className={styles.danger}>
      <div className={styles.dangerText}>
        <div className={styles.dangerTitle}>{m.views.profile.dangerTitle}</div>
        <p className={styles.dangerBody}>{m.views.profile.dangerBody}</p>
      </div>

      <button
        type="button"
        className={`${styles.action} ${styles.destructive}`}
        disabled={login === ''}
        onClick={() => setAsking(true)}
      >
        <Icon name="trash" size={13} />
        {m.views.profile.deleteAccount}
      </button>

      {asking ? (
        <DeleteAccountDialog login={login} onClose={() => setAsking(false)} />
      ) : null}
    </div>
  );
}
