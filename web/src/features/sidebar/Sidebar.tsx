import { useMemo, useRef, useState } from 'react';

import type { FolderNode, NoteNode } from '@/api/workspace';
import { allTags } from '@/lib/search';
import { usePrefs } from '@/store/prefs';
import { movable, type TreeRow, treeRows, useWorkspace } from '@/store/workspace';
import { type MenuItem, useContextMenu } from '@/ui/ContextMenu';
import { Icon, type IconName } from '@/ui/Icon';
import { useNamePrompt } from '@/ui/NamePrompt';
import { tip } from '@/ui/Tooltip';

import { IconPicker, type PickerTarget, pickerPosition } from './IconPicker';
import styles from './sidebar.module.css';

const INDENT = 13;

// How far the hand travels before a press on a row becomes a drag rather than a click.
const DRAG_SLOP_PX = 4;

export function Sidebar({
  onOpenPalette,
  onOpenPermissions,
}: {
  onOpenPalette: () => void;
  onOpenPermissions: (folderId: number) => void;
}) {
  const {
    vaults,
    vaultId,
    tree,
    index,
    view,
    connector,
    expanded,
    open,
    setView,
    setQuery,
    toggleFolder,
    addFolder,
    addNote,
    openNote,
    rename,
    setIcon,
    move,
    trash,
  } = useWorkspace();

  const readOnly = usePrefs((state) => state.readOnly);

  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  // Three states, not two: a folder id, the root, and "nowhere this may land". Only the
  // first two are a destination, and undefined is what keeps a refused drop unhighlighted.
  const [dropOn, setDropOn] = useState<number | null | undefined>(undefined);

  const treeRef = useRef<HTMLDivElement>(null);
  // A drag ends in a click on whatever the hand released over. Left alone it would open the
  // note or collapse the folder that was just moved.
  const dragged = useRef(false);

  const vault = vaults.find((v) => v.id === vaultId);
  const rows = treeRows(tree, expanded);
  const tags = useMemo(() => allTags(index).slice(0, 8), [index]);

  const { ask, dialog } = useNamePrompt();
  const { open: openMenu, menu } = useContextMenu();

  const askIcon = (anchor: DOMRect, node: FolderNode | NoteNode, kind: 'folder' | 'file') =>
    setPicker({
      ...pickerPosition(anchor),
      current: node.icon,
      onPick: (icon) => void setIcon(node, kind, icon),
    });

  const askRename = (node: FolderNode | NoteNode, kind: 'folder' | 'file') =>
    void ask('Name', node.name).then((name) => {
      if (name && name !== node.name) void rename(node, kind, name);
    });

  const askNote = (folderId: number | null) =>
    void ask('Note title', 'Untitled').then((title) => {
      if (title) void addNote(folderId, title);
    });

  const askFolder = (parentId: number | null) =>
    void ask('Folder name', 'New folder').then((name) => {
      if (name) void addFolder(parentId, name);
    });

  /**
   * The folder a point falls into: a folder row takes the drop itself, a note row hands it to
   * the folder it sits in, and bare space in the tree means the vault root. Undefined is the
   * pointer being somewhere that is not a destination at all — over the nav, the tags, or
   * outside the sidebar.
   */
  const targetAt = (x: number, y: number): number | null | undefined => {
    const list = treeRef.current;
    if (!list) return undefined;

    const under = document.elementFromPoint(x, y);
    if (!under || !list.contains(under)) return undefined;

    const row = under.closest<HTMLElement>('[data-node-id]');
    if (!row) return null;

    if (row.dataset.nodeKind === 'folder') return Number(row.dataset.nodeId);

    return row.dataset.parentId ? Number(row.dataset.parentId) : null;
  };

  /**
   * Dragging runs on pointer events rather than the drag-and-drop API, as the editor's tab
   * strip does: a row is a div full of buttons, and a native drag started on one of those is
   * the browser's to interpret. The listeners live on the window because a hand carrying a
   * row leaves the sidebar freely, and a drag that ends out there still has to end.
   */
  const grab = (event: React.PointerEvent, row: TreeRow) => {
    // A row that cannot be moved is not picked up at all: a drag that highlights nothing and
    // ends nowhere reads as a broken tree rather than as a mode.
    if (event.button !== 0 || row.node.locked || readOnly) return;

    const node = row.node;
    const kind = row.kind === 'folder' ? ('folder' as const) : ('file' as const);
    const from = { x: event.clientX, y: event.clientY };
    let armed = false;

    dragged.current = false;

    const aim = (x: number, y: number): number | null | undefined => {
      const target = targetAt(x, y);

      return target !== undefined && movable(tree, vault, node, kind, target) ? target : undefined;
    };

    const carry = (moved: PointerEvent) => {
      if (
        !armed &&
        Math.abs(moved.clientX - from.x) < DRAG_SLOP_PX &&
        Math.abs(moved.clientY - from.y) < DRAG_SLOP_PX
      ) {
        return;
      }

      armed = true;
      setDragging(node.id);
      setDropOn(aim(moved.clientX, moved.clientY));
    };

    const release = (ended: PointerEvent) => {
      stop();
      if (!armed) return;

      dragged.current = true;

      const target = aim(ended.clientX, ended.clientY);
      if (target !== undefined) void move(node, kind, target);
    };

    // A cancelled pointer is the system taking the hand away mid-drag; the row stays put.
    const abandon = () => {
      stop();
      dragged.current = armed;
    };

    function stop() {
      window.removeEventListener('pointermove', carry);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', abandon);

      setDragging(null);
      setDropOn(undefined);
    }

    window.addEventListener('pointermove', carry);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', abandon);
  };

  /** Everything a row can do, including the verbs the hover strip has no width to show. */
  const rowMenu = (row: TreeRow, anchor: DOMRect): MenuItem[] => {
    const node = row.node;
    const kind = row.kind === 'folder' ? 'folder' : 'file';

    const head: MenuItem[] =
      row.kind === 'folder'
        ? [
            // An empty folder has nothing to expand, so it is not offered.
            ...(row.hasChildren
              ? [
                  {
                    label: row.expanded ? 'Collapse' : 'Expand',
                    icon: row.expanded ? ('down' as const) : ('chev' as const),
                    onSelect: () => toggleFolder(node.id),
                  },
                ]
              : []),
            ...(readOnly
              ? []
              : ([
                  { label: 'New folder here', icon: 'folder', onSelect: () => askFolder(node.id) },
                  { label: 'New note here', icon: 'plus', onSelect: () => askNote(node.id) },
                ] as MenuItem[])),
            { label: 'Permissions', icon: 'user', onSelect: () => onOpenPermissions(node.id) },
          ]
        : [{ label: 'Open', icon: 'doc', onSelect: () => void openNote(node as NoteNode) }];

    // In read-only the menu is what is left when every verb that writes is taken out of it,
    // which for a note is one entry. Showing them greyed would only invite the click.
    if (readOnly) return head;

    return [
      ...head,
      { label: 'Rename', icon: 'tag', onSelect: () => askRename(node, kind) },
      { label: 'Change icon', icon: 'star', onSelect: () => askIcon(anchor, node, kind) },
      {
        label: 'Move to trash',
        icon: 'trash',
        danger: true,
        separated: true,
        onSelect: () => void trash(node as FolderNode | NoteNode, kind),
      },
    ];
  };

  return (
    <div className={styles.sidebar}>
      {dialog}
      {menu}
      <div className={styles.search}>
        <button type="button" className={styles.searchButton} onClick={onOpenPalette}>
          <Icon name="search" />
          <span className={styles.searchLabel}>Quick find</span>
          <span className={styles.shortcut}>⌘K</span>
        </button>
      </div>

      <div className={styles.scroll}>
        <button
          type="button"
          className={`${styles.navItem} ${view === 'editor' ? styles.navItemActive : ''}`}
          onClick={() => setView('editor')}
        >
          <Icon name="doc" style={{ flex: 'none', opacity: 0.8 }} />
          <span className={styles.navLabel}>Notes</span>
          <span className={styles.navCount}>{tree.notes.length}</span>
        </button>

        <button
          type="button"
          className={`${styles.navItem} ${view === 'search' ? styles.navItemActive : ''}`}
          onClick={() => setView('search')}
        >
          <Icon name="search" style={{ flex: 'none', opacity: 0.8 }} />
          <span className={styles.navLabel}>Search</span>
          <span className={styles.navCount}>{index.length}</span>
        </button>

        {/* Only where the server was given a key. On any other vault it would be a view of
            something that does not exist. */}
        {connector ? (
          <button
            type="button"
            className={`${styles.navItem} ${view === 'claude' ? styles.navItemActive : ''}`}
            onClick={() => setView('claude')}
          >
            <Icon name="claude" style={{ flex: 'none', opacity: 0.8 }} />
            <span className={styles.navLabel}>Claude</span>
          </button>
        ) : null}

        <button
          type="button"
          className={`${styles.navItem} ${view === 'graph' ? styles.navItemActive : ''}`}
          onClick={() => setView('graph')}
        >
          <Icon name="graph" style={{ flex: 'none', opacity: 0.8 }} />
          <span className={styles.navLabel}>Graph</span>
        </button>

        <button
          type="button"
          className={`${styles.navItem} ${view === 'trash' ? styles.navItemActive : ''}`}
          onClick={() => setView('trash')}
        >
          <Icon name="trash" style={{ flex: 'none', opacity: 0.8 }} />
          <span className={styles.navLabel}>Trash</span>
        </button>

        {/* The drop zone is this block rather than the whole scroller: the nav above and the
            tags below are not destinations. It takes in the vault heading on purpose — a full
            tree leaves no bare space under the last row, and the root has to stay reachable. */}
        <div ref={treeRef} className={`${styles.tree} ${dropOn === null ? styles.treeTarget : ''}`}>
          <div className={styles.sectionHead}>
            <span className={styles.sectionTitle}>{vault?.name ?? 'VAULT'}</span>
            {readOnly ? null : (
              <span className={styles.sectionActions}>
                <button
                  type="button"
                  className={styles.sectionButton}
                  {...tip('New folder')}
                  onClick={() => askFolder(null)}
                >
                  <Icon name="folder" size={13} />
                </button>
                <button
                  type="button"
                  className={styles.sectionButton}
                  {...tip('New note')}
                  onClick={() => askNote(null)}
                >
                  <Icon name="plus" size={13} />
                </button>
              </span>
            )}
          </div>

          {rows.length === 0 ? (
            <p className={styles.emptyHint}>
              {readOnly
                ? 'Nothing here yet, and read-only mode is on — turn it off in the account menu to add anything.'
                : 'Nothing here yet. Add a folder or a note — both are encrypted before they leave this device.'}
            </p>
          ) : null}

          {rows.map((row) => {
            const node = row.node;
            const isFolder = row.kind === 'folder';
            const isActive = !isFolder && open?.note.id === node.id;
            const kind = isFolder ? 'folder' : 'file';
            const parentId = isFolder ? (node as FolderNode).parentId : (node as NoteNode).folderId;

            return (
              <div
                key={`${row.kind}-${node.id}`}
                data-node-id={node.id}
                data-node-kind={row.kind}
                data-parent-id={parentId ?? undefined}
                className={[
                  styles.row,
                  isFolder ? styles.rowFolder : '',
                  isActive ? styles.rowActive : '',
                  node.locked ? styles.rowLocked : '',
                  dragging === node.id ? styles.rowMoving : '',
                  isFolder && dropOn === node.id ? styles.rowTarget : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onPointerDown={(event) => grab(event, row)}
                onClick={() => {
                  if (node.locked || dragged.current) return;

                  if (isFolder) toggleFolder(node.id);
                  else void openNote(node as NoteNode);
                }}
                onContextMenu={(event) => {
                  // A locked node has no verbs — there is no key here to rename or trash with
                  // — but the platform menu stays suppressed either way.
                  event.preventDefault();
                  if (node.locked) return;

                  openMenu(event, rowMenu(row, event.currentTarget.getBoundingClientRect()));
                }}
              >
                <span className={styles.indent} style={{ width: row.depth * INDENT }} />

                <Icon
                  name="chev"
                  size={11}
                  className={[
                    styles.chevron,
                    row.expanded ? styles.chevronOpen : '',
                    isFolder && row.hasChildren ? '' : styles.chevronHidden,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                />

                <button
                  type="button"
                  {...(readOnly ? {} : tip('Change icon'))}
                  className={[
                    styles.rowIcon,
                    isFolder ? styles.rowIconFolder : '',
                    isActive ? styles.rowIconActive : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={(event) => {
                    // With no picker behind it the mark is not a control of its own, so the
                    // press is left to reach the row and open the note.
                    if (node.locked || readOnly) return;

                    event.stopPropagation();
                    askIcon(event.currentTarget.getBoundingClientRect(), node, kind);
                  }}
                >
                  <Icon name={(node.icon as IconName) ?? (isFolder ? 'folder' : 'doc')} />
                </button>

                <span className={styles.rowName}>{node.name}</span>

                {/* A node that owns its key and shares it with nobody is the solo key the
                    design marks; it is the only badge that is true without a members list. */}
                {node.ownScope && node.grantCount <= 1 ? (
                  <span className={styles.badge}>SOLO KEY</span>
                ) : null}

                {node.locked ? <Icon name="lock" size={11} className={styles.badge} /> : null}

                {!node.locked && !readOnly ? (
                  <span className={styles.rowActions} onClick={(event) => event.stopPropagation()}>
                    {/* Both verbs behind one button: the sidebar is 250px, and a row four
                        levels down has no width left for a strip of five. The rest of what a
                        folder can do lives in the right-click menu. */}
                    {isFolder ? (
                      <button
                        type="button"
                        className={styles.rowAction}
                        {...tip('New here')}
                        onClick={(event) =>
                          openMenu(event, [
                            {
                              label: 'New folder',
                              icon: 'folder',
                              onSelect: () => askFolder(node.id),
                            },
                            { label: 'New note', icon: 'plus', onSelect: () => askNote(node.id) },
                          ])
                        }
                      >
                        <Icon name="plus" size={12} />
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={styles.rowAction}
                      {...tip('Rename')}
                      onClick={() => askRename(node, kind)}
                    >
                      <Icon name="tag" size={12} />
                    </button>
                    <button
                      type="button"
                      className={styles.rowAction}
                      {...tip('Move to trash')}
                      onClick={() => void trash(node as FolderNode | NoteNode, kind)}
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>

        {tags.length ? (
          <>
            <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>TAGS</span>
            </div>
            <div className={styles.facets}>
              {tags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={styles.facet}
                  onClick={() => setQuery(`#${tag}`)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>

      {picker ? <IconPicker target={picker} onClose={() => setPicker(null)} /> : null}
    </div>
  );
}
