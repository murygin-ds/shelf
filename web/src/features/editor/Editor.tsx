import { useEffect, useRef, useState } from 'react';

import { useWorkspace } from '@/store/workspace';
import { Icon, type IconName } from '@/ui/Icon';

import styles from './editor.module.css';

/** Long enough that typing does not turn into one request per keystroke. */
const AUTOSAVE_MS = 1200;

export function Editor() {
  const { open, saving, editBody, saveNote, rename, openNote } = useWorkspace();
  const [title, setTitle] = useState(open?.note.name ?? '');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setTitle(open?.note.name ?? '');
  }, [open?.note.id, open?.note.name]);

  // Debounced autosave, plus an explicit ⌘S for people who do not trust one.
  useEffect(() => {
    if (!open?.dirty) return;

    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveNote(), AUTOSAVE_MS);

    return () => window.clearTimeout(timer.current);
  }, [open?.body, open?.dirty, saveNote]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveNote();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [saveNote]);

  if (!open) return null;

  const note = open.note;
  const readOnly = open.locked || note.permission === 'view' || note.permission === 'comment';

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== note.name) void rename(note, 'file', next);
    else setTitle(note.name);
  };

  return (
    <div className={styles.pane}>
      <div className={styles.tabs}>
        <button type="button" className={styles.tab}>
          <Icon name={(note.icon as IconName) ?? 'doc'} size={13} style={{ color: 'var(--accent)' }} />
          <span className={styles.tabName}>{note.name}</span>
        </button>
      </div>

      <div className={styles.scroll}>
        <div className={styles.document}>
          <div className={styles.header}>
            <button type="button" className={styles.iconButton} title="Change icon" disabled>
              <Icon name={(note.icon as IconName) ?? 'doc'} size={21} />
            </button>
            <input
              className={styles.title}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={commitTitle}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              disabled={readOnly}
              spellCheck={false}
            />
          </div>

          <div className={styles.meta}>
            <span>UPDATED {relative(note.updatedAt)}</span>
            <span className={styles.metaSeparator}>·</span>
            <span className={styles.metaE2e}>
              <Icon name="lock" size={11} />
              E2E
            </span>
            <span className={styles.metaSeparator}>·</span>
            <span>{note.permission.toUpperCase()}</span>
            {open.dirty ? (
              <>
                <span className={styles.metaSeparator}>·</span>
                <span>{saving ? 'ENCRYPTING…' : 'UNSAVED'}</span>
              </>
            ) : null}
          </div>

          {open.locked ? (
            <div className={styles.locked}>
              <Icon name="lock" size={16} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                This note is encrypted under a key you do not hold. The server cannot help — only
                someone who already has access can grant it.
              </span>
            </div>
          ) : (
            <textarea
              className={styles.body}
              value={open.body}
              onChange={(event) => editBody(event.target.value)}
              onBlur={() => void saveNote()}
              placeholder="Write in markdown. Everything here is encrypted before it leaves this device."
              disabled={readOnly}
              spellCheck={false}
            />
          )}

          {open.conflict ? (
            <div className={styles.conflict}>
              <Icon name="warn" size={15} style={{ flex: 'none', marginTop: 2 }} />
              <div>
                Someone else saved this note while you were editing. The server holds ciphertext it
                cannot read, so it cannot merge the two versions — you have to choose.
                <div className={styles.conflictActions}>
                  <button
                    type="button"
                    className={styles.conflictButton}
                    onClick={() => void openNote(note)}
                  >
                    Discard mine and reload
                  </button>
                  <button
                    type="button"
                    className={styles.conflictButton}
                    onClick={() => void navigator.clipboard?.writeText(open.body)}
                  >
                    Copy my version
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function relative(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

  if (seconds < 60) return 'JUST NOW';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M AGO`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}H AGO`;

  return `${Math.floor(seconds / 86400)}D AGO`;
}
