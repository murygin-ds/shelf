import { useEffect, useState } from 'react';

import { Editor } from '@/features/editor/Editor';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './shell.module.css';

export function Workspace() {
  const { user, identity, signOut, lock } = useSession();
  const workspace = useWorkspace();
  const { vaults, vaultId, open, loading, error, load } = workspace;

  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (identity) void load(identity);
  }, [identity, load]);

  const vault = vaults.find((v) => v.id === vaultId);

  const newVault = () => {
    const name = window.prompt('Vault name', 'Personal');
    if (name && identity) void workspace.createVault(name.trim() || 'Personal', identity);
    setMenuOpen(false);
  };

  return (
    <div className={styles.app}>
      <div className={styles.topbar}>
        <div className={styles.switcher}>
          <button
            type="button"
            className={styles.switcherButton}
            onClick={() => setMenuOpen((value) => !value)}
          >
            <span className={styles.vaultDot} />
            <span>{vault?.name ?? (loading ? 'Loading…' : 'No vault')}</span>
            <Icon name="down" size={12} style={{ color: 'var(--text-quiet)' }} />
          </button>

          {menuOpen ? (
            <div className={styles.menu}>
              <div className={styles.menuHead}>
                <Icon name="lock" size={12} />
                SELF-HOSTED · {window.location.host.toUpperCase()}
              </div>

              {vaults.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={styles.menuItem}
                  onClick={() => {
                    if (identity) void workspace.selectVault(item.id, identity);
                    setMenuOpen(false);
                  }}
                >
                  <span className={styles.vaultDot} style={{ width: 9, height: 9, borderRadius: 3 }} />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span className={styles.menuName}>{item.name}</span>
                    <span className={styles.menuMeta} style={{ display: 'block' }}>
                      {item.noteCount} notes · {item.memberCount} member
                      {item.memberCount === 1 ? '' : 's'}
                    </span>
                  </span>
                  <span className={styles.rolePill}>{item.role.toUpperCase()}</span>
                </button>
              ))}

              <div className={styles.menuDivider} />

              <div style={{ display: 'flex', gap: 4 }}>
                <button type="button" className={styles.menuAction} onClick={newVault}>
                  <Icon name="plus" size={13} />
                  New vault
                </button>
              </div>
            </div>
          ) : null}
        </div>

        <div className={styles.breadcrumb}>
          {open ? (
            <>
              <span>{vault?.name}</span>
              <span className={styles.crumbSeparator}>/</span>
              <span className={styles.crumbCurrent}>{open.note.name}</span>
              <span className={styles.savedDot} />
              <span className={styles.savedLabel}>
                {open.dirty ? 'UNSAVED' : 'SAVED · ENCRYPTED'}
              </span>
            </>
          ) : null}
        </div>

        <div className={styles.topbarRight}>
          <button type="button" className={styles.iconButton} title="Lock keys" onClick={lock}>
            <Icon name="lock" size={16} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            title="Sign out"
            onClick={() => void signOut()}
          >
            <Icon name="user" size={16} />
          </button>
        </div>
      </div>

      {error ? (
        <div className={styles.banner}>
          <Icon name="warn" size={14} />
          <span>{error}</span>
          <button
            type="button"
            className={styles.bannerClose}
            onClick={() => useWorkspace.setState({ error: null })}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      ) : null}

      <div className={styles.body}>
        <Sidebar />

        <div className={styles.canvas}>
          {open ? (
            <Editor />
          ) : (
            <div className={styles.empty}>
              <Icon name="doc" size={22} style={{ color: 'var(--text-disabled)' }} />
              <div className={styles.emptyTitle}>
                {vault ? 'Nothing open' : 'No vault yet'}
              </div>
              <p className={styles.emptyLede}>
                {vault
                  ? 'Pick a note from the sidebar, or add one. Titles and bodies are encrypted here before anything is sent.'
                  : 'Create a vault to start. Its key is generated on this device and sealed to your own public key.'}
              </p>
              {!vault ? (
                <button type="button" className={styles.primaryButton} onClick={newVault}>
                  New vault
                </button>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <div className={styles.statusbar}>
        {/* Counted from the tree rather than the vault summary: these are the nodes this
            member can actually open, which is what the sidebar shows them. */}
        <span>
          {vault
            ? `${workspace.tree.notes.length} NOTES · ${workspace.tree.folders.length} FOLDERS`
            : 'NO VAULT'}
        </span>
        <span className={styles.statusSpacer} />
        <span>MARKDOWN</span>
        <span className={styles.statusOk}>
          <Icon name="lock" size={11} />
          E2E · AES-256-GCM
        </span>
        <span>{window.location.host.toUpperCase()}</span>
        <span className={styles.statusOk}>
          <span className={styles.statusDot} />
          {user?.login.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
