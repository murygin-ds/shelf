import { useEffect, useState } from 'react';

import type { ExportProgress, VaultExport } from '@/api/transfer';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';

import { describe, summarize } from './report';
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
  const locked = tree.notes.length - notes + (tree.folders.length - folders);

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
            <div className={styles.title}>Export vault</div>
            <div className={styles.subtitle}>
              {vault ? `${vault.name} · ${notes} notes · ${folders} folders` : 'No vault open'}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className={styles.body}>
          {written ? (
            <>
              <p className={styles.lede}>
                {written.notes} {written.notes === 1 ? 'note' : 'notes'} and {written.folders}{' '}
                {written.folders === 1 ? 'folder' : 'folders'} written to{' '}
                <strong>{written.filename}</strong>.
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
                <span>
                  The file on your disk is plain text. Keep it somewhere you would keep the notes
                  themselves, or delete it once you have what you needed.
                </span>
              </div>
            </>
          ) : (
            <>
              <div className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.noteIcon}>
                  <Icon name="warn" size={13} />
                </span>
                <span>
                  <strong>This archive is not encrypted.</strong> Every note leaves this device as
                  markdown anybody holding the file can read. Shelf’s protection ends at the
                  download; where you keep the file is the only protection it has left.
                </span>
              </div>

              <div className={styles.section}>WHAT GOES IN</div>
              <ul className={styles.list}>
                <li>
                  {notes} {notes === 1 ? 'note' : 'notes'} as markdown, in the folders you see in
                  the sidebar.
                </li>
                <li>
                  A <code>shelf.json</code> that records names, icons and tags exactly, so the
                  archive can be imported back.
                </li>
                <li>Items in the trash are not included.</li>
                {locked > 0 ? (
                  <li>
                    {locked} {locked === 1 ? 'item is' : 'items are'} left out: you hold no key for
                    {locked === 1 ? ' it' : ' them'}.
                  </li>
                ) : null}
              </ul>

              {progress ? (
                <div className={styles.progress}>
                  READING BODIES {progress.done}/{progress.total}
                </div>
              ) : null}
            </>
          )}

          {error ? <div className={styles.error}>{error}</div> : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>THE ARCHIVE IS NOT ENCRYPTED</span>
          <span className={styles.footerSpacer} />
          {written ? (
            <button type="button" className={styles.done} onClick={onClose}>
              Done
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              onClick={() => void run()}
              disabled={busy || !vault || vault.locked}
            >
              {busy ? 'Exporting…' : 'Export'}
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
