import { useEffect, useState } from 'react';

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
        <span className={styles.title}>TRASH</span>
        <span className={styles.spacer} />
        <span className={styles.legend}>
          {rows.length} ITEM{rows.length === 1 ? '' : 'S'}
        </span>
      </div>

      <div className={styles.body}>
        {rows.length === 0 ? (
          <p className={styles.empty}>
            Nothing deleted. Items land here when you remove them, still encrypted, until
            you either put them back or destroy them for good.
          </p>
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

                {node.locked ? (
                  <span className={styles.meta}>NO KEY</span>
                ) : (
                  <span className={styles.meta}>{kind === 'folder' ? 'FOLDER' : 'NOTE'}</span>
                )}

                <button
                  type="button"
                  className={styles.action}
                  disabled={busy}
                  onClick={() => void act(() => restore(node.id, kind))}
                >
                  Restore
                </button>

                {confirming === key ? (
                  <button
                    type="button"
                    className={`${styles.action} ${styles.destructive}`}
                    disabled={busy}
                    onClick={() => void act(() => purge(node.id, kind))}
                  >
                    Destroy for good
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles.action}
                    disabled={busy}
                    onClick={() => setConfirming(key)}
                  >
                    Delete forever
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className={styles.note}>
        Restoring a folder brings back what was inside it. Deleting forever destroys the
        ciphertext — there is no copy anywhere that could bring it back, here or on the
        server.
      </p>
    </div>
  );
}
