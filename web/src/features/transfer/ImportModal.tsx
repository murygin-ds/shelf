import { useEffect, useRef, useState, type DragEvent } from 'react';

import type { ImportProgress, ImportReport } from '@/api/transfer';
import { parseArchive, type ImportPlan } from '@/lib/archive';
import { unzip } from '@/lib/zip';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';

import { describe, summarize } from './report';
import styles from './transfer.module.css';

/**
 * Reading an archive back in.
 *
 * It always builds a *new* vault. Merging into an existing one would mean deciding what a
 * second copy of a note means, and nothing in the archive answers that; a vault of its own
 * leaves the choice — keep it, move things across, delete it — with the reader.
 */
export function ImportModal({ onClose }: { onClose: () => void }) {
  const identity = useSession((state) => state.identity);
  const importVault = useWorkspace((state) => state.importVault);
  const dismiss = useDismiss(onClose);

  const chooser = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [name, setName] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // A reload halfway through leaves a half-filled vault and no way to say which half.
  useEffect(() => {
    if (!busy) return;

    const hold = (event: BeforeUnloadEvent) => event.preventDefault();

    window.addEventListener('beforeunload', hold);

    return () => window.removeEventListener('beforeunload', hold);
  }, [busy]);

  const read = async (file: File) => {
    setError(null);

    try {
      const opened = parseArchive(await unzip(await file.arrayBuffer()));

      setPlan(opened);
      setName(opened.vault.name);
    } catch (cause) {
      setPlan(null);
      setError(describe(cause));
    }
  };

  const drop = (event: DragEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setOver(false);

    const file = event.dataTransfer.files[0];
    if (file) void read(file);
  };

  const run = async () => {
    if (!plan || !identity) return;

    setBusy(true);
    setError(null);

    try {
      setReport(await importVault(plan, name.trim() || plan.vault.name, identity, setProgress));
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
            <div className={styles.title}>Import a vault</div>
            <div className={styles.subtitle}>From an archive Shelf wrote</div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className={styles.body}>
          {report ? (
            <>
              <p className={styles.lede}>
                <strong>{name}</strong> now holds {report.notes}{' '}
                {report.notes === 1 ? 'note' : 'notes'} in {report.folders}{' '}
                {report.folders === 1 ? 'folder' : 'folders'}.
              </p>

              {report.skipped.length > 0 ? (
                <div className={styles.note}>
                  <span className={styles.noteIcon}>
                    <Icon name="warn" size={13} />
                  </span>
                  <span>{summarize(report.skipped)}</span>
                </div>
              ) : null}

              {report.failures.length > 0 ? (
                <div className={styles.note}>
                  <span className={styles.noteIcon}>
                    <Icon name="warn" size={13} />
                  </span>
                  <span>
                    {report.failures.length} {report.failures.length === 1 ? 'node' : 'nodes'} could
                    not be written: {report.failures[0]?.message}. The vault was kept as it stands —
                    delete it from the vault menu if you would rather start again.
                  </span>
                </div>
              ) : null}

              <div className={styles.section}>WHAT AN ARCHIVE CANNOT CARRY</div>
              <ul className={styles.list}>
                <li>Revision history, and the signatures on it.</li>
                <li>Members, permissions and keys: this vault is yours alone.</li>
                <li>Folders that had a key of their own — everything here is under the vault key.</li>
              </ul>
            </>
          ) : (
            <>
              <p className={styles.lede}>
                This creates a <strong>new</strong> vault. Nothing in the vaults you already have is
                read or changed.
              </p>

              <input
                ref={chooser}
                type="file"
                accept=".zip,application/zip"
                className={styles.file}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void read(file);
                }}
              />

              <button
                type="button"
                className={`${styles.picker} ${over ? styles.pickerOver : ''}`}
                onClick={() => chooser.current?.click()}
                onDragOver={(event) => {
                  event.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={drop}
              >
                <Icon name="inbox" size={18} />
                {plan ? 'Choose a different archive' : 'Choose an archive'}
                <span className={styles.pickerHint}>or drop a .zip here</span>
              </button>

              {plan ? (
                <>
                  <div className={styles.summary}>
                    <div className={styles.summaryTitle}>{plan.vault.name}</div>
                    <div className={styles.summaryMeta}>
                      {plan.notes.length} {plan.notes.length === 1 ? 'note' : 'notes'} ·{' '}
                      {plan.folders.length} {plan.folders.length === 1 ? 'folder' : 'folders'}
                      {plan.exportedAt ? ` · exported ${plan.exportedAt.slice(0, 10)}` : ''}
                    </div>
                  </div>

                  {plan.skipped.length > 0 ? (
                    <div className={styles.note}>
                      <span className={styles.noteIcon}>
                        <Icon name="warn" size={13} />
                      </span>
                      <span>{summarize(plan.skipped)}</span>
                    </div>
                  ) : null}

                  <label className={styles.field}>
                    <span className={styles.label}>NAME THE NEW VAULT</span>
                    <input
                      className={styles.input}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                </>
              ) : null}

              {progress ? (
                <div className={styles.progress}>
                  {PHASES[progress.phase]} {progress.done}/{progress.total} · KEEP THIS TAB OPEN
                </div>
              ) : null}
            </>
          )}

          {error ? <div className={styles.error}>{error}</div> : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            {report ? 'THE ARCHIVE ON YOUR DISK IS STILL PLAIN TEXT' : 'A NEW VAULT, KEYED HERE'}
          </span>
          <span className={styles.footerSpacer} />
          {report ? (
            <button type="button" className={styles.done} onClick={onClose}>
              Done
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              onClick={() => void run()}
              disabled={!plan || !identity || busy}
            >
              {busy ? 'Importing…' : 'Create vault'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

const PHASES: Record<ImportProgress['phase'], string> = {
  vault: 'CREATING THE VAULT',
  folders: 'CREATING FOLDERS',
  notes: 'WRITING NOTES',
  links: 'LINKING',
};
