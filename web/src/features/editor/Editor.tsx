import { useEffect, useMemo, useRef, useState } from 'react';

import { allTags } from '@/lib/search';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon, type IconName } from '@/ui/Icon';
import { useContextMenu } from '@/ui/ContextMenu';
import { tip } from '@/ui/Tooltip';

import { contextOf } from './context';
import { MarkdownEditor, type LinkWhere } from './MarkdownEditor';
import { editorMenu, tableMenu } from './menu';
import styles from './editor.module.css';

/** Long enough that typing does not turn into one request per keystroke. */
const AUTOSAVE_MS = 1200;

export function Editor() {
  const {
    open,
    saving,
    tabs,
    tree,
    index,
    editBody,
    saveNote,
    rename,
    openNote,
    openInBackground,
    closeTab,
    saveAsCopy,
  } = useWorkspace();
  const identity = useSession((state) => state.identity);
  const [title, setTitle] = useState(open?.note.name ?? '');
  const timer = useRef<number | undefined>(undefined);
  const { open: openMenu, menu } = useContextMenu();

  // Keyed on a cheap signature rather than on the array: the poller hands out a new
  // `tree.notes` every eight seconds with the same contents in it, and reconfiguring the
  // editor on each of those would be work for nothing.
  const signature = tree.notes.map((note) => `${note.id}:${note.name}`).join('|');
  // A tag can hold no whitespace, so joining them is a signature and a value at once.
  const tags = allTags(index).join(' ');

  const context = useMemo(
    () =>
      contextOf(
        tree.notes.map((note) => ({ id: note.id, name: note.name })),
        tags ? tags.split(' ') : [],
      ),
    [signature, tags],
  );

  useEffect(() => {
    setTitle(open?.note.name ?? '');
  }, [open?.note.id, open?.note.name]);

  // Debounced autosave, plus an explicit ⌘S for people who do not trust one.
  useEffect(() => {
    if (!open?.dirty) return;

    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void saveNote(identity ?? undefined), AUTOSAVE_MS);

    return () => window.clearTimeout(timer.current);
  }, [open?.body, open?.dirty, saveNote, identity]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveNote(identity ?? undefined);
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [saveNote, identity]);

  if (!open) return null;

  // The tab on screen goes last. Closing it hands the editor to whatever tab is left, and
  // that hand-off loads a body asynchronously — so it has to happen when the survivors are
  // already known, or the editor ends up on a note the strip no longer lists.
  const closeOthers = (keep: number) => {
    const openId = open.note.id;

    for (const tab of tabs) {
      if (tab.id !== keep && tab.id !== openId) closeTab(tab.id);
    }

    if (openId !== keep) closeTab(openId);
  };

  const note = open.note;
  const readOnly = open.locked || note.permission === 'view' || note.permission === 'comment';

  /**
   * Resolved here rather than in the editor, and by the same rule the graph uses: titles are
   * encrypted, so only a holder of the key can turn one into a note — and when two notes
   * share a title the older one wins, so the same body always leads to the same place.
   */
  const openLink = (target: string, where: LinkWhere) => {
    const wanted = target.trim().toLowerCase();

    const found = tree.notes
      .filter((candidate) => candidate.name.trim().toLowerCase() === wanted)
      .sort((a, b) => a.id - b.id)[0];

    if (!found) return;

    if (where === 'tab') openInBackground(found);
    else void openNote(found);
  };

  const commitTitle = () => {
    const next = title.trim();
    if (next && next !== note.name) void rename(note, 'file', next);
    else setTitle(note.name);
  };

  return (
    <div className={styles.pane}>
      {menu}

      <div className={styles.tabs}>
        {tabs.map((tab) => {
          const active = tab.id === note.id;

          return (
            <span
              key={tab.id}
              className={`${styles.tab} ${active ? styles.tabActive : ''}`}
              // Middle-click closes the tab. The mousedown has to be swallowed too, or the
              // browser starts its own autoscroll on the way to the click.
              onMouseDown={(event) => {
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;

                event.preventDefault();
                closeTab(tab.id);
              }}
              onContextMenu={(event) =>
                openMenu(event, [
                  { label: 'Close', icon: 'x', onSelect: () => closeTab(tab.id) },
                  { label: 'Close others', onSelect: () => closeOthers(tab.id) },
                  {
                    // Others first, so the open note is the last tab standing when it goes
                    // and the store closes the editor instead of loading a neighbour that
                    // is about to be closed too.
                    label: 'Close all',
                    onSelect: () => {
                      closeOthers(tab.id);
                      closeTab(tab.id);
                    },
                  },
                ])
              }
            >
              <button
                type="button"
                className={styles.tabOpen}
                onClick={() => {
                  if (!active) void openNote(tab);
                }}
              >
                <Icon
                  name={(tab.icon as IconName) ?? 'doc'}
                  size={13}
                  {...(active ? { style: { color: 'var(--accent)' } } : {})}
                />
                <span className={styles.tabName}>{tab.name}</span>
              </button>

              <button
                type="button"
                className={styles.tabClose}
                {...tip('Close')}
                onClick={() => closeTab(tab.id)}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          );
        })}
      </div>

      <div className={styles.scroll}>
        <div className={styles.document}>
          <div className={styles.header}>
            <button type="button" className={styles.iconButton} {...tip('Change icon')} disabled>
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
            <MarkdownEditor
              className={styles.body}
              docId={note.id}
              value={open.body}
              readOnly={readOnly}
              context={context}
              placeholder={
                readOnly
                  ? 'This note is empty.'
                  : 'Write in markdown. Everything here is encrypted before it leaves this device.'
              }
              onChange={editBody}
              onBlur={() => void saveNote(identity ?? undefined)}
              onOpenLink={openLink}
              onContextMenu={(event, view, pos) =>
                openMenu(event, editorMenu(view, pos, (link) => openLink(link.target, link.where)))
              }
              onTableMenu={(event, ref) => openMenu(event, tableMenu(ref))}
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
                    disabled={saving}
                    onClick={() => void saveAsCopy(identity ?? undefined)}
                  >
                    Save mine as a new note
                  </button>
                  <button
                    type="button"
                    className={styles.conflictButton}
                    onClick={() => void navigator.clipboard?.writeText(open.body)}
                  >
                    Copy to clipboard
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
