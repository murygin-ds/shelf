import { useEffect, useState } from 'react';

import { describe } from '@/api/errors';
import type { ExportProgress, VaultExport } from '@/api/transfer';
import { m } from '@/i18n';
import { MANIFEST_PATH } from '@/lib/archive';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';

import { summarize } from './report';
import styles from './transfer.module.css';

/**
 * Writing the vault out as a plain zip.
 *
 * The archive leaves the protection behind: every note in it is markdown that anybody holding
 * the file can read. That is the point of an export and the thing worth saying first, so it is
 * a warning above the button rather than a line under it.
 */
export function ExportModal({ onClose }: { onClose: () => void }) {
  const { vaults, vaultId, tree, exportVault } = useWorkspace();
  const dismiss = useDismiss(onClose);

  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [written, setWritten] = useState<VaultExport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const vault = vaults.find((candidate) => candidate.id === vaultId);
  const notes = tree.notes.filter((note) => !note.locked).length;
  const folders = tree.folders.filter((folder) => !folder.locked).length;
  const lockedNotes = tree.notes.length - notes;
  const lockedFolders = tree.folders.length - folders;

  const run = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await exportVault(setProgress);

      download(result.blob, result.filename);
      setWritten(result);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.modal}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{m.transfer.exporting.title}</div>
            <div className={styles.subtitle}>
              {vault
                ? m.transfer.exporting.subtitle(vault.name, notes, folders)
                : m.transfer.exporting.noVault}
            </div>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={onClose}
            aria-label={m.common.close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className={styles.body}>
          {written ? (
            <>
              <p className={styles.lede}>
                <strong>{written.filename}</strong>{' '}
                {m.transfer.exporting.wrote(written.notes, written.folders)}
              </p>

              {written.skipped.length > 0 ? (
                <div className={styles.note}>
                  <span className={styles.noteIcon}>
                    <Icon name="warn" size={13} />
                  </span>
                  <span>{summarize(written.skipped)}</span>
                </div>
              ) : null}

              <div className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.noteIcon}>
                  <Icon name="lock" size={13} />
                </span>
                <span>{m.transfer.exporting.keepItSafe}</span>
              </div>
            </>
          ) : (
            <>
              <div className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.noteIcon}>
                  <Icon name="warn" size={13} />
                </span>
                <span>
                  <strong>{m.transfer.exporting.warnLead}</strong> {m.transfer.exporting.warnBody}
                </span>
              </div>

              <div className={styles.section}>{m.transfer.exporting.section}</div>
              <ul className={styles.list}>
                <li>{m.transfer.exporting.asMarkdown(notes)}</li>
                <li>
                  <code>{MANIFEST_PATH}</code> {m.transfer.exporting.manifest}
                </li>
                <li>{m.transfer.exporting.noTrash}</li>
                {lockedFolders + lockedNotes > 0 ? (
                  <li>{m.transfer.exporting.noKey(lockedFolders, lockedNotes)}</li>
                ) : null}
              </ul>

              {progress ? (
                <div className={styles.progress}>
                  {m.transfer.exporting.reading(progress.done, progress.total)}
                </div>
              ) : null}
            </>
          )}

          {error ? <div className={styles.error}>{error}</div> : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>{m.transfer.exporting.footerNote}</span>
          <span className={styles.footerSpacer} />
          {written ? (
            <button type="button" className={styles.done} onClick={onClose}>
              {m.common.done}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              onClick={() => void run()}
              disabled={busy || !vault || vault.locked}
            >
              {busy ? m.transfer.exporting.busy : m.transfer.exporting.run}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Same shape as the recovery kit download: a blob, a click, and the URL let go at once. */
function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.href = url;
  anchor.download = filename;
  anchor.click();

  URL.revokeObjectURL(url);
}
