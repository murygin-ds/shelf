import { useMemo, useState } from 'react';

import type { FolderNode, NoteNode } from '@/api/workspace';
import { allTags } from '@/lib/search';
import { useSession } from '@/store/session';
import { type TreeRow, treeRows, useWorkspace } from '@/store/workspace';
import { type MenuItem, useContextMenu } from '@/ui/ContextMenu';
import { Icon, type IconName } from '@/ui/Icon';
import { useNamePrompt } from '@/ui/NamePrompt';
import { tip } from '@/ui/Tooltip';

import { IconPicker, type PickerTarget, pickerPosition } from './IconPicker';
import styles from './sidebar.module.css';

const INDENT = 13;

export function Sidebar({
  onOpenPalette,
  onOpenPermissions,
}: {
  onOpenPalette: () => void;
  onOpenPermissions: (folderId: number) => void;
}) {
  const { user } = useSession();
  const {
    vaults,
    vaultId,
    tree,
    index,
    view,
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
    trash,
  } = useWorkspace();

  const [picker, setPicker] = useState<PickerTarget | null>(null);

  const vault = vaults.find((v) => v.id === vaultId);
  const rows = treeRows(tree, expanded);
  const tags = useMemo(() => allTags(index).slice(0, 8), [index]);
  const initials = (user?.display_name ?? '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');

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

  /** The same verbs the row already offers on hover, reachable with the right button. */
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
            { label: 'New note here', icon: 'plus', onSelect: () => askNote(node.id) },
            { label: 'Permissions', icon: 'user', onSelect: () => onOpenPermissions(node.id) },
          ]
        : [{ label: 'Open', icon: 'doc', onSelect: () => void openNote(node as NoteNode) }];

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

        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{vault?.name ?? 'VAULT'}</span>
          <span className={styles.sectionActions}>
            <button
              type="button"
              className={styles.sectionButton}
              {...tip('New folder')}
              onClick={() =>
                void ask('Folder name', 'New folder').then((name) => {
                  if (name) void addFolder(null, name);
                })
              }
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
        </div>

        {rows.length === 0 ? (
          <p className={styles.emptyHint}>
            Nothing here yet. Add a folder or a note — both are encrypted before they leave this
            device.
          </p>
        ) : null}

        {rows.map((row) => {
          const node = row.node;
          const isFolder = row.kind === 'folder';
          const isActive = !isFolder && open?.note.id === node.id;
          const kind = isFolder ? 'folder' : 'file';

          return (
            <div
              key={`${row.kind}-${node.id}`}
              className={[
                styles.row,
                isFolder ? styles.rowFolder : '',
                isActive ? styles.rowActive : '',
                node.locked ? styles.rowLocked : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => {
                if (node.locked) return;

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
                {...tip('Change icon')}
                className={[
                  styles.rowIcon,
                  isFolder ? styles.rowIconFolder : '',
                  isActive ? styles.rowIconActive : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={(event) => {
                  event.stopPropagation();
                  if (node.locked) return;

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

              {!node.locked ? (
                <span className={styles.rowActions} onClick={(event) => event.stopPropagation()}>
                  {isFolder ? (
                    <button
                      type="button"
                      className={styles.rowAction}
                      {...tip('Permissions')}
                      onClick={() => onOpenPermissions(node.id)}
                    >
                      <Icon name="user" size={12} />
                    </button>
                  ) : null}
                  {isFolder ? (
                    <button
                      type="button"
                      className={styles.rowAction}
                      {...tip('New note here')}
                      onClick={() => askNote(node.id)}
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

      <div className={styles.footer}>
        <span className={styles.footerAvatar}>{initials}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className={styles.footerName}>{user?.display_name}</div>
          <div className={styles.footerState}>
            {(vault?.role ?? 'member').toUpperCase()} · KEY UNLOCKED
          </div>
        </div>
      </div>

      {picker ? <IconPicker target={picker} onClose={() => setPicker(null)} /> : null}
    </div>
  );
}
