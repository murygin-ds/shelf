import { useEffect, useState } from 'react';

import { MembersModal } from '@/features/access/MembersModal';
import { PermissionsModal } from '@/features/access/PermissionsModal';
import { SecurityModal } from '@/features/access/SecurityModal';
import { Editor } from '@/features/editor/Editor';
import { GraphView } from '@/features/graph/GraphView';
import { Inspector } from '@/features/inspector/Inspector';
import { SearchView } from '@/features/search/SearchView';
import { TrashView } from '@/features/trash/TrashView';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';
import { NamePrompt, useNamePrompt } from '@/ui/NamePrompt';
import { tip } from '@/ui/Tooltip';

import { CommandPalette } from './CommandPalette';
import { VaultSwitcher } from './VaultSwitcher';
import styles from './shell.module.css';

export function Workspace() {
  const { user, identity, signOut, lock } = useSession();
  const workspace = useWorkspace();
  const {
    vaults,
    vaultId,
    open,
    view,
    loaded,
    loading,
    error,
    offline,
    syncing,
    queued,
    coverage,
    load,
  } = workspace;

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [permissionsFor, setPermissionsFor] = useState<number | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const { ask, dialog } = useNamePrompt();

  useEffect(() => {
    if (identity) void load(identity);
  }, [identity, load]);

  // One poller for the whole shell, torn down on unmount so a remount cannot stack timers.
  useEffect(() => {
    if (vaultId === null) return;

    return workspace.startPolling();
  }, [vaultId, workspace.startPolling]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const vault = vaults.find((v) => v.id === vaultId);
  const permissionsFolder =
    permissionsFor === null
      ? null
      : (workspace.tree.folders.find((folder) => folder.id === permissionsFor) ?? null);

  const newVault = () =>
    void ask('Vault name', 'Personal').then((name) => {
      if (name && identity) void workspace.createVault(name, identity);
    });

  // A fresh account has nowhere to put anything: folders, notes and keys all hang off a
  // vault, so every create verb in the shell is a no-op until one exists. The first one is
  // therefore not a choice — this prompt has no cancel and stays up until a vault is made.
  // `loaded` gates it: an empty list before the first read is just an unanswered request.
  const needsFirstVault = loaded && vaults.length === 0;

  return (
    <div className={styles.app}>
      {dialog}

      {needsFirstVault ? (
        <NamePrompt
          label="Name your first vault"
          initial="Personal"
          hint="Everything you write lives in a vault. Its key is generated on this device and sealed to your own public key, so nothing readable ever leaves it."
          error={error}
          confirmLabel="Create vault"
          busy={loading}
          onSubmit={(name) => {
            if (identity) void workspace.createVault(name, identity);
          }}
        />
      ) : null}

      <div className={styles.topbar}>
        <VaultSwitcher onNewVault={newVault} />

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
          {vault ? (
            <>
              <button
                type="button"
                className={styles.iconButton}
                {...tip(
                  vault.keyState === 'pending_rotation'
                    ? 'A removed member still holds this key — rotate it'
                    : 'Keys & history',
                )}
                onClick={() => setSecurityOpen(true)}
              >
                <Icon
                  name={vault.keyState === 'pending_rotation' ? 'warn' : 'key'}
                  size={16}
                  {...(vault.keyState === 'pending_rotation'
                    ? { style: { color: 'var(--warn)' } }
                    : {})}
                />
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => setMembersOpen(true)}
              >
                Share
              </button>
            </>
          ) : null}
          <button type="button" className={styles.iconButton} {...tip('Lock keys')} onClick={lock}>
            <Icon name="lock" size={16} />
          </button>
          <button
            type="button"
            className={styles.iconButton}
            {...tip('Sign out')}
            onClick={() => void signOut()}
          >
            <Icon name="user" size={16} />
          </button>
        </div>
      </div>

      {/* While the first-vault prompt is up it carries the error itself: a banner behind the
          overlay would be unreadable and its close button unclickable. */}
      {error && !needsFirstVault ? (
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
        <Sidebar
          onOpenPalette={() => setPaletteOpen(true)}
          onOpenPermissions={(folderId) => setPermissionsFor(folderId)}
        />

        <div className={styles.canvas}>
          {view === 'search' ? (
            <SearchView />
          ) : view === 'graph' ? (
            <GraphView />
          ) : view === 'trash' ? (
            <TrashView />
          ) : open ? (
            <>
              <Editor />
              <Inspector note={open.note} />
            </>
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
        {coverage.total > 0 && coverage.covered < coverage.total ? (
          <span>
            INDEX {coverage.covered}/{coverage.total}
          </span>
        ) : null}
        <span>MARKDOWN</span>
        <span className={styles.statusOk}>
          <Icon name="lock" size={11} />
          E2E · AES-256-GCM
        </span>
        <span className={styles.statusOk}>
          <span className={styles.statusDot} style={offline ? { background: 'var(--warn)' } : undefined} />
          {offline
            ? queued > 0
              ? `OFFLINE · ${queued} QUEUED`
              : 'OFFLINE · CACHED'
            : queued > 0
              ? `SENDING ${queued}`
              : syncing
                ? 'SYNCING'
                : 'SYNCED'}
        </span>
        <span>{user?.login.toUpperCase()}</span>
      </div>

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      {membersOpen ? <MembersModal onClose={() => setMembersOpen(false)} /> : null}
      {securityOpen ? <SecurityModal onClose={() => setSecurityOpen(false)} /> : null}
      {permissionsFolder ? (
        <PermissionsModal folder={permissionsFolder} onClose={() => setPermissionsFor(null)} />
      ) : null}
    </div>
  );
}
