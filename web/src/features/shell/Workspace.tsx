import { useEffect, useMemo, useState } from 'react';

import { MembersModal } from '@/features/access/MembersModal';
import { PermissionsModal } from '@/features/access/PermissionsModal';
import { SecurityModal } from '@/features/access/SecurityModal';
import { Editor } from '@/features/editor/Editor';
import { GraphView } from '@/features/graph/GraphView';
import { Inspector } from '@/features/inspector/Inspector';
import { ProfileView } from '@/features/profile/ProfileView';
import { SearchView } from '@/features/search/SearchView';
import { TrashView } from '@/features/trash/TrashView';
import { Sidebar } from '@/features/sidebar/Sidebar';
import { ExportModal } from '@/features/transfer/ExportModal';
import { ImportModal } from '@/features/transfer/ImportModal';
import { usePrefs } from '@/store/prefs';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { summarize } from '@/sync/status';
import { Icon } from '@/ui/Icon';
import { NamePrompt, useNamePrompt } from '@/ui/NamePrompt';
import { tip } from '@/ui/Tooltip';

import { AccountMenu } from './AccountMenu';
import { CommandPalette } from './CommandPalette';
import { VaultSwitcher } from './VaultSwitcher';
import { useShellHistory } from './history';
import styles from './shell.module.css';

export function Workspace() {
  const { identity } = useSession();
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
    saving,
    queued,
    lastSyncedAt,
    coverage,
    load,
  } = workspace;

  const { readOnly, setReadOnly } = usePrefs();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [permissionsFor, setPermissionsFor] = useState<number | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const { ask, dialog } = useNamePrompt();

  const restoredVaultId = useShellHistory(identity);

  useEffect(() => {
    if (identity) void load(identity, restoredVaultId ?? undefined);
  }, [identity, load, restoredVaultId]);

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

  // Counted from the body in memory rather than the saved copy: what the status bar reports
  // is what is on screen, including the keystrokes that have not been sealed yet.
  const counted = useMemo(() => {
    const body = open?.body.trim() ?? '';

    return { words: body ? body.split(/\s+/).length : 0, chars: open?.body.length ?? 0 };
  }, [open?.body]);

  // A poll that finds nothing takes a few dozen milliseconds, and flashing SYNCING at every
  // one of them every eight seconds reads as trouble rather than as work. Only a sync that
  // outlasts this is worth saying out loud.
  const pulling = useHeldTrue(syncing, SYNC_FLICKER_MS);

  const status = summarize({
    offline,
    syncing: pulling,
    saving,
    dirty: open?.dirty ?? false,
    queued,
    lastSyncedAt,
    now: Date.now(),
  });

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
  //
  // Read-only is the one way out of it: a prompt with no cancel, in front of a mode that
  // refuses the very thing it asks for, would be a wall.
  const needsFirstVault = loaded && vaults.length === 0 && !readOnly;

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
        <VaultSwitcher
          onNewVault={newVault}
          onMembers={() => setMembersOpen(true)}
          onSecurity={() => setSecurityOpen(true)}
          onExport={() => setExportOpen(true)}
          onImport={() => setImportOpen(true)}
        />

        <div className={styles.breadcrumb}>
          {open ? (
            <>
              <span>{vault?.name}</span>
              <span className={styles.crumbSeparator}>/</span>
              <span className={styles.crumbCurrent}>{open.note.name}</span>
              <span
                className={styles.savedDot}
                data-tone={open.dirty ? 'busy' : open.queued ? 'warn' : 'ok'}
              />
              <span className={styles.savedLabel}>
                {open.dirty
                  ? 'UNSAVED'
                  : open.queued
                    ? 'SAVED HERE · NOT SENT'
                    : 'SAVED · ENCRYPTED'}
              </span>
            </>
          ) : null}
        </div>

        <div className={styles.topbarRight}>
          {readOnly ? (
            <button
              type="button"
              className={styles.readOnly}
              {...tip('Nothing on this device writes to any vault. Click to turn it off.')}
              onClick={() => setReadOnly(false)}
            >
              <Icon name="eye" size={12} />
              READ ONLY
            </button>
          ) : null}

          <AccountMenu />
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
          ) : view === 'profile' ? (
            <ProfileView />
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
                  ? readOnly
                    ? 'Pick a note from the sidebar. Read-only mode is on, so nothing here can be changed from this device.'
                    : 'Pick a note from the sidebar, or add one. Titles and bodies are encrypted here before anything is sent.'
                  : readOnly
                    ? 'There is nothing to read yet, and read-only mode is on — turn it off to create the first vault.'
                    : 'Create a vault to start. Its key is generated on this device and sealed to your own public key.'}
              </p>
              {!vault && !readOnly ? (
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
        {/* The note behind the graph or the trash is not what the reader is looking at, so
            the counts belong to the editor rather than to whatever is merely open. */}
        {open && view === 'editor' ? (
          <span>
            {counted.words} {counted.words === 1 ? 'WORD' : 'WORDS'} · {counted.chars}{' '}
            {counted.chars === 1 ? 'CHAR' : 'CHARS'}
          </span>
        ) : null}
        <span className={styles.status} data-tone={status.tone} title={status.detail}>
          <span className={styles.statusDot} />
          {status.label}
        </span>
      </div>

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
      {membersOpen ? <MembersModal onClose={() => setMembersOpen(false)} /> : null}
      {securityOpen ? <SecurityModal onClose={() => setSecurityOpen(false)} /> : null}
      {exportOpen ? <ExportModal onClose={() => setExportOpen(false)} /> : null}
      {importOpen ? <ImportModal onClose={() => setImportOpen(false)} /> : null}
      {permissionsFolder ? (
        <PermissionsModal folder={permissionsFolder} onClose={() => setPermissionsFor(null)} />
      ) : null}
    </div>
  );
}

/** How long a sync has to run before the status line calls it one. */
const SYNC_FLICKER_MS = 400;

/** True once `value` has stayed true for `delayMs`, and false the instant it stops. */
function useHeldTrue(value: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!value) {
      setHeld(false);
      return;
    }

    const timer = window.setTimeout(() => setHeld(true), delayMs);

    return () => window.clearTimeout(timer);
  }, [value, delayMs]);

  return held;
}
