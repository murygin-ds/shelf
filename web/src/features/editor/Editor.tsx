import { useEffect, useMemo, useRef, useState } from 'react';

import { IconPicker, type PickerTarget, pickerPosition } from '@/features/sidebar/IconPicker';
import { allTags } from '@/lib/search';
import { usePrefs } from '@/store/prefs';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon, type IconName } from '@/ui/Icon';
import { useContextMenu } from '@/ui/ContextMenu';
import { tip } from '@/ui/Tooltip';

import { contextOf } from './context';
import { MarkdownEditor, type LinkWhere } from './MarkdownEditor';
import { editorMenu, tableMenu } from './menu';
import { Peers } from './Peers';
import styles from './editor.module.css';

/** Long enough that typing does not turn into one request per keystroke. */
const AUTOSAVE_MS = 1200;

/** How far the pointer travels before a press on a tab counts as a move rather than a click. */
const DRAG_SLOP_PX = 4;

export function Editor() {
  const {
    open,
    saving,
    tabs,
    tree,
    index,
    collab,
    peers,
    editBody,
    saveNote,
    startEditing,
    stopEditing,
    rename,
    setIcon,
    openNote,
    openInBackground,
    moveTab,
    closeTab,
    saveAsCopy,
  } = useWorkspace();
  const identity = useSession((state) => state.identity);
  const user = useSession((state) => state.user);
  const frozen = usePrefs((state) => state.readOnly);
  const [title, setTitle] = useState(open?.note.name ?? '');
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const strip = useRef<HTMLDivElement | null>(null);
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

  // The live session for the note on screen. It is opened here rather than in openNote
  // because the identity lives in the session store, and this is where the two meet.
  //
  // Read-only is one of the things that ends it: switching the mode on with a room already
  // up would leave this tab holding the committer's job. The teardown writes the document
  // back on the way out, which is the last thing this device writes — refusing that would
  // strand text that was typed while writing was still allowed.
  const noteId = open?.note.id;
  useEffect(() => {
    if (noteId === undefined || !identity || !user || frozen) return;

    void startEditing(identity, { userId: user.id, name: user.display_name });

    return () => stopEditing();
  }, [noteId, identity, user, frozen, startEditing, stopEditing]);

  // Debounced autosave, plus an explicit ⌘S for people who do not trust one. With a live
  // session both are no-ops: the committer writes the body back on its own schedule, and
  // saveNote steps aside rather than racing it.
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

  // Reordering runs on pointer events rather than on the drag-and-drop API: a tab is a pair
  // of buttons, and a native drag started on one of those is at the browser's discretion.
  // The listeners are on the window because a hand moving a tab leaves the strip freely, and
  // a drag that ends out there still has to end.
  const grab = (event: React.PointerEvent, id: number) => {
    if (event.button !== 0) return;

    const from = event.clientX;
    // The strip as it stood when the tab was picked up. Frozen on purpose: the slots shift
    // as the tab travels through them, and measuring the thing that is moving makes the
    // answer depend on whether the browser has painted the last move yet.
    const edges = Array.from(strip.current?.children ?? []).map(
      (slot) => slot.getBoundingClientRect().right,
    );
    let armed = false;

    const move = (moved: PointerEvent) => {
      if (!armed && Math.abs(moved.clientX - from) < DRAG_SLOP_PX) return;

      armed = true;
      setDragging(id);
      moveTab(id, slotAt(edges, moved.clientX));
    };

    const drop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', drop);
      setDragging(null);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
  };

  const note = open.note;
  const readOnly =
    frozen || open.locked || note.permission === 'view' || note.permission === 'comment';

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

      <div className={styles.tabs} ref={strip}>
        {tabs.map((tab) => {
          const active = tab.id === note.id;

          return (
            <span
              key={tab.id}
              data-tab={tab.id}
              className={`${styles.tab} ${active ? styles.tabActive : ''} ${
                dragging === tab.id ? styles.tabMoving : ''
              }`}
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
                onPointerDown={(event) => grab(event, tab.id)}
                // A tab that was dragged is opened too, as it is in every browser: the press
                // that moved it is still a press on it.
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
            <button
              type="button"
              className={styles.iconButton}
              {...tip('Change icon')}
              disabled={readOnly}
              onClick={(event) =>
                setPicker({
                  ...pickerPosition(event.currentTarget.getBoundingClientRect()),
                  current: note.icon,
                  onPick: (icon) => void setIcon(note, 'file', icon),
                })
              }
            >
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
            {/* The mode outranks the permission here: what the reader may do with this note
                and what this device will do with it are the same line, and in read-only the
                second one is the answer. */}
            <span>{frozen ? 'READ ONLY' : note.permission.toUpperCase()}</span>
            {open.dirty ? (
              <>
                <span className={styles.metaSeparator}>·</span>
                <span>{saving ? 'ENCRYPTING…' : 'UNSAVED'}</span>
              </>
            ) : null}
            <Peers peers={peers} selfId={user?.id} />
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
              collab={collab ?? undefined}
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
              onContextMenu={(event, view, pos) => {
                const items = editorMenu(view, pos, (link) => openLink(link.target, link.where));

                // Nothing to offer — reading, with no selection and no link under the
                // pointer. Suppressing the platform menu is only worth doing when something
                // takes its place, so here it is left alone.
                if (items.length === 0) return false;

                openMenu(event, items);

                return true;
              }}
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
                  {/* A conflict cannot arise while read-only is on, but one raised before it
                      went on is still on screen — and keeping this copy means writing one. */}
                  {frozen ? null : (
                    <button
                      type="button"
                      className={styles.conflictButton}
                      disabled={saving}
                      onClick={() => void saveAsCopy(identity ?? undefined)}
                    >
                      Save mine as a new note
                    </button>
                  )}
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

      {picker ? <IconPicker target={picker} onClose={() => setPicker(null)} /> : null}
    </div>
  );
}

/** The slot a pointer at `x` is over, given each slot's right edge. Past the end is the end. */
function slotAt(edges: number[], x: number): number {
  const at = edges.findIndex((edge) => x < edge);

  return at < 0 ? edges.length - 1 : at;
}

function relative(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

  if (seconds < 60) return 'JUST NOW';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M AGO`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}H AGO`;

  return `${Math.floor(seconds / 86400)}D AGO`;
}
