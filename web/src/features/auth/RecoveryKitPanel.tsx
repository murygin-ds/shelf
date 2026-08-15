import { useState } from 'react';

import { recoveryKitFilename, renderRecoveryKit } from '@/crypto/recovery';
import { useSession } from '@/store/session';
import { Icon } from '@/ui/Icon';

import { origin } from './AuthLayout';
import styles from './auth.module.css';

/**
 * The one moment the recovery code exists outside the user's head. It is never sent
 * anywhere and cannot be shown again, so the flow refuses to move on until the user
 * confirms they kept it.
 */
export function RecoveryKitPanel({ code, onDone }: { code: string; onDone: () => void }) {
  const { user, identity } = useSession();
  const [saved, setSaved] = useState(false);
  const [downloaded, setDownloaded] = useState(false);

  const download = () => {
    const login = user?.login ?? 'account';

    const text = renderRecoveryKit({
      login,
      displayName: user?.display_name ?? '',
      code,
      fingerprint: identity?.fingerprint ?? '',
      issuedAt: new Date(),
      origin: origin().toLowerCase(),
    });

    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = recoveryKitFilename(login);
    anchor.click();

    URL.revokeObjectURL(url);
    setDownloaded(true);
  };

  return (
    <>
      <h1 className={styles.title}>Save your recovery kit</h1>
      <p className={styles.lede}>
        This code is shown once. It is the only way back into your notes if you forget your
        passphrase.
      </p>

      <div className={styles.code}>{code}</div>

      <div className={styles.notice} style={{ marginTop: 16 }}>
        <Icon name="key" size={14} className={styles.noticeIcon} />
        <div className={styles.noticeBody}>
          <span className={styles.noticeLabel}>ZERO-KNOWLEDGE</span>
          The server holds your master key wrapped with a key derived from this code, and cannot
          unwrap it. Neither can your administrator.
        </div>
      </div>

      <div className={styles.kitActions}>
        <button type="button" className={styles.secondary} onClick={download}>
          {downloaded ? 'Download again' : 'Download kit'}
        </button>
        <button
          type="button"
          className={styles.secondary}
          onClick={() => void navigator.clipboard?.writeText(code)}
        >
          Copy code
        </button>
      </div>

      {/* One control, not a checkbox nested in a label: a label re-dispatches the click
          to the control it wraps, which cancels the toggle it just caused. */}
      <button
        type="button"
        role="checkbox"
        aria-checked={saved}
        className={styles.confirm}
        onClick={() => setSaved((value) => !value)}
      >
        <span className={`${styles.checkbox} ${saved ? styles.checkboxOn : ''}`}>
          {saved ? <Icon name="check" size={9} /> : null}
        </span>
        I stored this code somewhere safe and offline.
      </button>

      <button
        type="button"
        className={styles.primary}
        style={{ width: '100%', marginTop: 14 }}
        disabled={!saved}
        onClick={onDone}
      >
        Open Shelf
      </button>
    </>
  );
}
