import { useEffect, useState } from 'react';

import { m } from '@/i18n';
import { usePrefs } from '@/store/prefs';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './trash.module.css';

/**
 * What was deleted, and the two things that can still be done with it.
 *
 * Trashed rows are loaded on demand rather than kept in the synced tree: they are not part
 * of what anybody is working on, and holding them in memory would mean decrypting every
 * deleted note on every reconnect.
 */
export function TrashView() {
  const { vaultId, trashed, loadTrash, restore, purge } = useWorkspace();
  const readOnly = usePrefs((state) => state.readOnly);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // An armed row that outlives the list it was armed in could destroy whatever took its
  // place, so the arming expires on its own.
  useEffect(() => {
    if (!confirming) return;

    const timer = window.setTimeout(() => setConfirming(null), 10_000);

    return () => window.clearTimeout(timer);
  }, [confirming]);

  useEffect(() => {
    setConfirming(null);
    void loadTrash();
  }, [vaultId, loadTrash]);

  const rows = [
    ...trashed.folders.map((folder) => ({ kind: 'folder' as const, node: folder })),
    ...trashed.notes.map((note) => ({ kind: 'file' as const, node: note })),
  ];

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setConfirming(null);

    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.pane}>
      <div className={styles.head}>
        <span className={styles.title}>{m.views.trash.title}</span>
        <span className={styles.spacer} />
        <span className={styles.legend}>{m.views.trash.items(rows.length)}</span>
      </div>

      <div className={styles.body}>
        {rows.length === 0 ? (
          <p className={styles.empty}>{m.views.trash.empty}</p>
        ) : (
          rows.map(({ kind, node }) => {
            const key = `${kind}-${node.id}`;

            return (
              <div key={key} className={styles.row}>
                <Icon
                  name={kind === 'folder' ? 'folder' : 'doc'}
                  size={14}
                  style={{ flex: 'none', color: 'var(--text-quiet)' }}
                />

                <span className={styles.name}>{node.name}</span>

                <span className={styles.meta}>
                  {node.locked
                    ? m.views.trash.noKey
                    : kind === 'folder'
                      ? m.views.trash.folder
                      : m.views.trash.note}
                </span>

                {readOnly ? null : (
                  <>
                    <button
                      type="button"
                      className={styles.action}
                      disabled={busy}
                      onClick={() => void act(() => restore(node.id, kind))}
                    >
                      {m.views.trash.restore}
                    </button>

                    {confirming === key ? (
                      <button
                        type="button"
                        className={`${styles.action} ${styles.destructive}`}
                        disabled={busy}
                        onClick={() => void act(() => purge(node.id, kind))}
                      >
                        {m.views.trash.purgeArmed}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className={styles.action}
                        disabled={busy}
                        onClick={() => setConfirming(key)}
                      >
                        {m.views.trash.purge}
                      </button>
                    )}
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className={styles.note}>
        {readOnly ? m.views.trash.frozen : m.views.trash.footer}
      </p>
    </div>
  );
}
