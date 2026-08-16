import { useMemo, useState } from 'react';

import type { FolderNode, NoteNode } from '@/api/workspace';
import { allTags } from '@/lib/search';
import { useSession } from '@/store/session';
import { treeRows, useWorkspace } from '@/store/workspace';
import { Icon, type IconName } from '@/ui/Icon';

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

  const promptFor = (label: string, fallback: string): string | null => {
    const value = window.prompt(label, fallback);

    return value === null ? null : value.trim() || fallback;
  };

  return (
    <div className={styles.sidebar}>
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

        <div className={styles.sectionHead}>
          <span className={styles.sectionTitle}>{vault?.name ?? 'VAULT'}</span>
          <span className={styles.sectionActions}>
            <button
              type="button"
              className={styles.sectionButton}
              title="New folder"
              onClick={() => {
                const name = promptFor('Folder name', 'New folder');
                if (name) void addFolder(null, name);
              }}
            >
              <Icon name="folder" size={13} />
            </button>
            <button
              type="button"
              className={styles.sectionButton}
              title="New note"
              onClick={() => {
                const title = promptFor('Note title', 'Untitled');
                if (title) void addNote(null, title);
              }}
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
                title="Change icon"
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

                  const anchor = event.currentTarget.getBoundingClientRect();

                  setPicker({
                    ...pickerPosition(anchor),
                    current: node.icon,
                    onPick: (icon) => void setIcon(node, kind, icon),
                  });
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
                      title="Permissions"
                      onClick={() => onOpenPermissions(node.id)}
                    >
                      <Icon name="user" size={12} />
                    </button>
                  ) : null}
                  {isFolder ? (
                    <button
                      type="button"
                      className={styles.rowAction}
                      title="New note here"
                      onClick={() => {
                        const title = promptFor('Note title', 'Untitled');
                        if (title) void addNote(node.id, title);
                      }}
                    >
                      <Icon name="plus" size={12} />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.rowAction}
                    title="Rename"
                    onClick={() => {
                      const name = promptFor('Name', node.name);
                      if (name && name !== node.name) void rename(node, kind, name);
                    }}
                  >
                    <Icon name="tag" size={12} />
                  </button>
                  <button
                    type="button"
                    className={styles.rowAction}
                    title="Move to trash"
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
            <button
          type="button"
          className={`${styles.navItem} ${view === 'graph' ? styles.navItemActive : ''}`}
          onClick={() => setView('graph')}
        >
          <Icon name="graph" style={{ flex: 'none', opacity: 0.8 }} />
          <span className={styles.navLabel}>Graph</span>
        </button>

        <div className={styles.sectionHead}>
              <span className={styles.sectionTitle}>TAGS</span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '0 6px' }}>
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
