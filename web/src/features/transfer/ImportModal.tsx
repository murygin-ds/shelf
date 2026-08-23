import { useEffect, useRef, useState, type DragEvent } from 'react';

import { describe } from '@/api/errors';
import type { ImportProgress, ImportReport } from '@/api/transfer';
import { format, importPhaseLabel, m } from '@/i18n';
import { parseArchive, type ImportPlan } from '@/lib/archive';
import { unzip } from '@/lib/zip';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';

import { summarize } from './report';
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

  const failedFolders = report?.failures.filter((one) => one.kind === 'folder').length ?? 0;
  const failure = report?.failures[0];
  const exported = plan && plan.exportedAt !== '' ? exportedOn(plan.exportedAt) : null;

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.modal}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{m.transfer.importing.title}</div>
            <div className={styles.subtitle}>{m.transfer.importing.subtitle}</div>
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
          {report ? (
            <>
              <p className={styles.lede}>
                <strong>{name}</strong> {m.transfer.importing.filled(report.notes, report.folders)}
              </p>

              {report.skipped.length > 0 ? (
                <div className={styles.note}>
                  <span className={styles.noteIcon}>
                    <Icon name="warn" size={13} />
                  </span>
                  <span>{summarize(report.skipped)}</span>
                </div>
              ) : null}

              {failure ? (
                <div className={styles.note}>
                  <span className={styles.noteIcon}>
                    <Icon name="warn" size={13} />
                  </span>
                  <span>
                    {m.transfer.importing.failed(
                      failedFolders,
                      report.failures.length - failedFolders,
                      failure.message,
                    )}
                  </span>
                </div>
              ) : null}

              <div className={styles.section}>{m.transfer.importing.cannotCarry}</div>
              <ul className={styles.list}>
                <li>{m.transfer.importing.noHistory}</li>
                <li>{m.transfer.importing.noMembers}</li>
                <li>{m.transfer.importing.noScopes}</li>
              </ul>
            </>
          ) : (
            <>
              <p className={styles.lede}>
                <strong>{m.transfer.importing.ledeLead}</strong> {m.transfer.importing.ledeBody}
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
                {plan ? m.transfer.importing.another : m.transfer.importing.choose}
                <span className={styles.pickerHint}>{m.transfer.importing.dropHint}</span>
              </button>

              {plan ? (
                <>
                  <div className={styles.summary}>
                    <div className={styles.summaryTitle}>{plan.vault.name}</div>
                    <div className={styles.summaryMeta}>
                      {m.transfer.importing.summary(plan.notes.length, plan.folders.length)}
                      {exported === null ? '' : ` · ${exported}`}
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
                    <span className={styles.label}>{m.transfer.importing.nameLabel}</span>
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
                  {importPhaseLabel(progress.phase)} {progress.done}/{progress.total} ·{' '}
                  {m.transfer.importing.keepOpen}
                </div>
              ) : null}
            </>
          )}

          {error ? <div className={styles.error}>{error}</div> : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            {report ? m.transfer.importing.footerDone : m.transfer.importing.footerNew}
          </span>
          <span className={styles.footerSpacer} />
          {report ? (
            <button type="button" className={styles.done} onClick={onClose}>
              {m.common.done}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              onClick={() => void run()}
              disabled={!plan || !identity || busy}
            >
              {busy ? m.transfer.importing.busy : m.transfer.importing.run}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The stamp in the manifest is input like everything else, and `format.date` throws on a date
 * it cannot parse rather than returning something odd.
 */
function exportedOn(iso: string): string | null {
  const at = new Date(iso);

  return Number.isNaN(at.getTime()) ? null : m.transfer.importing.exportedOn(format.date(at));
}
