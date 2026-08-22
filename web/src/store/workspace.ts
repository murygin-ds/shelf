import { create } from 'zustand';

import { ApiError, OfflineError } from '@/api/client';
import { ErrorCode } from '@/api/types';
import * as collab from '@/api/collab';
import * as graphApi from '@/api/graph';
import * as rekeyApi from '@/api/rekey';
import * as transfer from '@/api/transfer';
import * as ws from '@/api/workspace';
import type { Identity } from '@/crypto/identity';
import type { ScopeKeyring } from '@/crypto/keyring';
import * as cache from '@/db/cache';
import type { ImportPlan } from '@/lib/archive';
import { claudeOsPlan } from '@/lib/claudeos';
import { MAX_TAGS, normalizeTag, type IndexedNote } from '@/lib/search';
import { resolveWikilinks } from '@/lib/wikilinks';
import { isReadOnly } from '@/store/prefs';
import type { PeerDto } from '@/api/realtime';
import { createSession, type EditingSession } from '@/collab/session';
import { b64ToBytes } from '@/crypto/bytes';
import type { CollabBinding } from '@/features/editor/MarkdownEditor';
import * as connectivity from '@/sync/connectivity';
import * as sync from '@/sync/engine';
import * as live from '@/sync/live';

export interface OpenNote {
  note: ws.NoteNode;
  body: string;
  contentSeq: number;
  locked: boolean;
  dirty: boolean;
  /** Written with no network and waiting in the outbox. */
  queued?: boolean;
  /** Set when the server refused a write because someone else got there first. */
  conflict: boolean;
}

export type View = 'editor' | 'search' | 'graph' | 'trash' | 'profile';

// MAX_TABS bounds the strip. Past a dozen the labels are unreadable and the strip stops
// being a way back to anything.
const MAX_TABS = 12;

// Mirrors the CHECK on folders.depth. Only a guard here: it bounds the walk up a tree the
// server would have refused to nest any deeper.
const MAX_DEPTH = 32;

interface WorkspaceState {
  vaults: ws.Vault[];
  vaultId: number | null;
  keyring: ScopeKeyring | null;
  tree: ws.Tree;
  expanded: Set<number>;
  open: OpenNote | null;
  view: View;
  query: string;
  /** Decrypted, in memory only. Persisting it would put plaintext on disk. */
  index: IndexedNote[];
  coverage: { covered: number; total: number };
  /** The vault list has been read at least once. An empty list only means something after it. */
  loaded: boolean;
  loading: boolean;
  saving: boolean;
  syncing: boolean;
  /**
   * The server could not be reached. Mirrored from the connectivity watch rather than
   * decided here, so it is true from the moment the network goes rather than from the first
   * request that happens to notice.
   */
  offline: boolean;
  /** When the last pull came back. Null until one does, which is not the same as synced. */
  lastSyncedAt: number | null;
  /** How far this device has read the vault. Compared against a hint before pulling on it. */
  cursor: number;
  /** Hints are arriving, so the poll can slow down. Never a reason to stop polling. */
  live: boolean;
  /** Bodies written with no network, waiting to be sent. */
  queued: number;
  /** The shared document behind the open note, while a live session is up. */
  collab: CollabBinding | null;
  /** Who else has this note open. Empty when nobody else does, or when the socket is down. */
  peers: PeerDto[];
  /** Whether this tab is the one writing the body back. Decided by the server, not here. */
  committer: boolean;
  error: string | null;

  /**
   * Reads the vault list and opens one. `preferVaultId` is the vault a restored URL names;
   * without it, or when that vault is gone, the first one opens.
   */
  load: (identity: Identity, preferVaultId?: number) => Promise<void>;
  selectVault: (vaultId: number, identity: Identity) => Promise<void>;
  createVault: (name: string, identity: Identity) => Promise<void>;
  /**
   * Destroys a vault of one's own, or walks out of somebody else's. Both end the same way
   * here — the vault is gone from this account — so they share the aftermath.
   */
  removeVault: (vaultId: number, mode: 'delete' | 'leave', identity: Identity) => Promise<void>;
  syncNow: () => Promise<void>;
  /**
   * Polls, watches the connection, and drains the outbox the moment it returns. Gives back
   * the teardown the caller has to run.
   */
  startPolling: () => () => void;
  toggleFolder: (folderId: number) => void;
  addFolder: (parentId: number | null, name: string) => Promise<void>;
  addNote: (folderId: number | null, title: string) => Promise<void>;
  openNote: (note: ws.NoteNode) => Promise<void>;
  /** Takes the editor off the note without touching the tab strip, unlike `closeTab`. */
  closeNote: () => void;
  editBody: (body: string) => void;
  saveNote: (identity?: Identity) => Promise<void>;
  /**
   * Opens the live session for the note on screen, if the socket is up. Called from the
   * editor rather than from openNote, because the identity lives in the session store and
   * the editor is where the two already meet.
   */
  startEditing: (identity: Identity, self: { userId: number; name: string }) => Promise<void>;
  stopEditing: () => void;
  /** Replays every body written while the network was gone. */
  flushOutbox: () => Promise<void>;
  rename: (node: ws.FolderNode | ws.NoteNode, kind: 'folder' | 'file', name: string) => Promise<void>;
  /**
   * Relocates a node under a folder, or to the vault root when `parentId` is null. A move the
   * server would refuse is dropped here instead of being sent — see `movable`.
   */
  move: (
    node: ws.FolderNode | ws.NoteNode,
    kind: 'folder' | 'file',
    parentId: number | null,
  ) => Promise<void>;
  setIcon: (
    node: ws.FolderNode | ws.NoteNode,
    kind: 'folder' | 'file',
    icon: string | undefined,
  ) => Promise<void>;
  /**
   * The note's own tags, as opposed to the `#tag` written into its body. They ride the same
   * encrypted meta as its name, so the server learns nothing from them.
   */
  setTags: (note: ws.NoteNode, tags: readonly string[]) => Promise<void>;
  /** Only the open vault: its scope key is the one the loaded keyring holds. */
  setVaultIcon: (icon: string | undefined) => Promise<void>;
  /**
   * Writes this account's private note on a vault, or clears it when the text is empty.
   * Any vault in the list, open or not: the label rides the identity key rather than the
   * vault's, so it needs no keyring.
   */
  setVaultLabel: (vaultId: number, label: string, identity: Identity) => Promise<void>;
  trash: (node: ws.FolderNode | ws.NoteNode, kind: 'folder' | 'file') => Promise<void>;
  /** What is in the trash, loaded on demand rather than kept in sync. */
  trashed: ws.Tree;
  loadTrash: () => Promise<void>;
  restore: (id: number, kind: 'folder' | 'file') => Promise<void>;
  /** Keeps a version that lost a conflict, as a note of its own. */
  saveAsCopy: (identity?: Identity) => Promise<void>;
  /**
   * Notes the reader has open, newest last. Only the one in `open` is loaded — the rest are
   * a list of places to go back to, which is what a tab strip is.
   */
  tabs: ws.NoteNode[];
  /**
   * Puts a note in the strip without taking the reader off the one they are on. Reads no
   * body: a tab is a `NoteNode` and a promise to come back, not a loaded document.
   */
  openInBackground: (note: ws.NoteNode) => void;
  /**
   * Sets a tab down at `to`, counted in the strip as it stands. From then on the order is
   * the reader's rather than the order the notes were opened in — including for `fit`, which
   * still drops from the left when the strip overflows.
   */
  moveTab: (noteId: number, to: number) => void;
  closeTab: (noteId: number) => void;
  purge: (id: number, kind: 'folder' | 'file') => Promise<void>;
  setView: (view: View) => void;
  setQuery: (query: string) => void;
  reset: () => Promise<void>;
  /**
   * Gives a node its own key, or rotates the one it has. The whole job runs here rather
   * than in the component, so a modal closing mid-way cannot abandon a half-staged re-key.
   */
  rekey: (
    target: { scopeType: 'vault' | 'folder' | 'file'; scopeRefId: number },
    identity: Identity,
    onProgress?: (progress: rekeyApi.RekeyProgress) => void,
  ) => Promise<void>;
  /**
   * Reads the open vault out as a plain archive. Everything in it is decrypted here — that is
   * what makes it readable anywhere, and what the dialog has to say out loud.
   */
  exportVault: (
    onProgress?: (progress: transfer.ExportProgress) => void,
  ) => Promise<transfer.VaultExport>;
  /**
   * Builds a new vault from an archive and moves to it.
   *
   * Both actions throw rather than reporting into `error`: the dialog that started them is
   * still up, and it holds the progress and the failure the banner behind it cannot show.
   */
  importVault: (
    plan: ImportPlan,
    name: string,
    identity: Identity,
    onProgress?: (progress: transfer.ImportProgress) => void,
  ) => Promise<transfer.ImportReport>;

  /**
   * Builds a vault laid out for Claude and moves to it.
   *
   * The tree is a plan like any other, so it travels the import path rather than a second
   * one: the sealing, the ordering and the failure counting are already right there.
   */
  createClaudeVault: (
    name: string,
    identity: Identity,
    onProgress?: (progress: transfer.ImportProgress) => void,
  ) => Promise<transfer.ImportReport>;
}

const emptyTree: ws.Tree = { folders: [], notes: [] };

/**
 * How long a hint waits before it becomes a pull. A move that renames twenty notes arrives
 * as one frame from the server, but a reconnect or two writers can still produce several.
 */
const HINT_DEBOUNCE_MS = 200;

/**
 * The live socket, kept beside the store rather than inside it: it outlives a re-render and
 * has to be reachable from selectVault, which is not where it was opened.
 */
let liveSession: live.LiveSession | null = null;

/**
 * What a write-back needs to know about the note it speaks for.
 *
 * It travels with the session rather than being read from `open`, because the last commit of
 * a session lands after the note was closed — that is what the commit on the way out is —
 * and the sequence it has to carry cannot be looked up once the editor has moved on.
 */
interface CommitTarget {
  note: ws.NoteNode;
  contentSeq: number;
}

/** The editing session for the note on screen, for the same reason. */
let editing: { target: CommitTarget; session: EditingSession } | null = null;

/**
 * The session that has stopped and is still writing back. The next one waits for it: its
 * write moves the sequence a new session has to start from, and a session that starts behind
 * is refused on every commit it ever makes.
 */
let settling: Promise<void> = Promise.resolve();

/**
 * Counts the sessions asked for, so a start suspended on a round trip can tell that it is no
 * longer the one wanted. StrictMode asks twice on its own, and without this the first answer
 * leaves a room open that nothing closes.
 */
let generation = 0;

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  vaults: [],
  vaultId: null,
  keyring: null,
  tree: emptyTree,
  trashed: emptyTree,
  tabs: [],
  expanded: new Set(),
  open: null,
  view: 'editor',
  query: '',
  index: [],
  coverage: { covered: 0, total: 0 },
  loaded: false,
  loading: false,
  saving: false,
  syncing: false,
  offline: !connectivity.isOnline(),
  lastSyncedAt: null,
  cursor: 0,
  live: false,
  queued: 0,
  collab: null,
  peers: [],
  committer: false,
  error: null,

  load: async (identity, preferVaultId) => {
    set({ loading: true, error: null });

    try {
      const vaults = await ws.listVaults(identity);
      set({ vaults, loaded: true });

      const wanted = vaults.find((vault) => vault.id === preferVaultId) ?? vaults[0];
      if (wanted && get().vaultId === null) await get().selectVault(wanted.id, identity);
    } catch (cause) {
      report(set, cause);
    } finally {
      set({ loading: false });
    }
  },

  selectVault: async (vaultId, identity) => {
    // Everything vault-shaped is cleared together. A trash list left over from the previous
    // vault would offer Restore and Delete buttons wired to ids in a vault the reader has
    // just left.
    set({
      loading: true,
      vaultId,
      open: null,
      tabs: [],
      tree: emptyTree,
      trashed: emptyTree,
      index: [],
      cursor: 0,
      error: null,
    });

    // Hints for the vault being left are of no use here, and the new one has to be followed
    // before the first change in it happens rather than at the next poll.
    liveSession?.follow(vaultId);

    try {
      const keyring = await ws.loadKeyring(vaultId, identity);
      set({ keyring, queued: await cache.outboxSize(vaultId) });

      // Anything left over from a previous session goes out before the first delta, so a
      // reload does not look like the write was lost.
      await get().flushOutbox();

      // Paint from the cache first: it holds ciphertext this device can already open, so
      // the tree appears without waiting for the network.
      const cached = await sync.fromCache(vaultId, keyring);
      if (cached.folders.length || cached.notes.length) {
        set({ tree: { folders: cached.folders, notes: cached.notes }, expanded: allOpen(cached.folders) });
      }

      await get().syncNow();
    } catch (cause) {
      report(set, cause);
    } finally {
      set({ loading: false });
    }
  },

  createVault: async (name, identity) => {
    if (isReadOnly()) return;

    set({ loading: true, error: null });

    try {
      const created = await ws.createVault(name, undefined, identity);
      set({ vaults: await ws.listVaults(identity) });
      await get().selectVault(created.id, identity);
    } catch (cause) {
      reportChange(set, cause);
    } finally {
      set({ loading: false });
    }
  },

  removeVault: async (vaultId, mode, identity) => {
    if (isReadOnly()) return;

    set({ loading: true, error: null });

    try {
      await (mode === 'delete' ? ws.deleteVault(vaultId) : collab.leaveVault(vaultId));

      // Whatever this device cached for it is unopenable from here on, and a queued write
      // for it can never land. Both go with the vault rather than sitting in IndexedDB.
      await cache.dropVault(vaultId);

      const vaults = await ws.listVaults(identity);
      set({ vaults });

      // Another vault was on screen, so nothing the reader is looking at has moved.
      if (get().vaultId !== vaultId) return;

      const next = vaults[0];
      if (next) {
        await get().selectVault(next.id, identity);
        return;
      }

      // Nothing left to fall back to. The shell's first-vault prompt takes it from here,
      // which it cannot do while the tree of a vault that no longer exists is still up.
      set({
        vaultId: null,
        keyring: null,
        tree: emptyTree,
        trashed: emptyTree,
        tabs: [],
        expanded: new Set(),
        open: null,
        index: [],
        coverage: { covered: 0, total: 0 },
        queued: 0,
      });
    } catch (cause) {
      reportChange(set, cause);
    } finally {
      set({ loading: false });
    }
  },

  syncNow: async () => {
    const { vaultId, keyring, syncing } = get();
    if (vaultId === null || !keyring || syncing) return;

    set({ syncing: true });

    try {
      const cursor = await cache.readCursor(vaultId);
      const pulled = await sync.pull(vaultId, keyring, cursor);

      const tree = { folders: pulled.folders, notes: pulled.notes };
      set({
        tree,
        cursor: pulled.cursor,
        lastSyncedAt: Date.now(),
        expanded: pulled.resynced || get().expanded.size === 0 ? allOpen(pulled.folders) : get().expanded,
      });

      // Every node the client is holding on to is re-projected from the delta rather than
      // filtered by id. A note that was renamed, moved or re-keyed elsewhere leaves a
      // snapshot here that names the wrong key scope — and a write sealed against it is
      // refused by the server, so the note becomes unsavable with nothing on screen to say
      // why.
      const open = get().open;

      if (open) {
        const fresh = tree.notes.find((note) => note.id === open.note.id);

        // Purged or trashed elsewhere.
        if (!fresh) set({ open: null });
        else if (fresh !== open.note) set({ open: { ...open, note: fresh } });
      }

      set({
        tabs: get()
          .tabs.map((tab) => tree.notes.find((note) => note.id === tab.id))
          .filter((tab): tab is ws.NoteNode => tab !== undefined),
      });

      const hydrated = await sync.hydrate(
        vaultId,
        keyring,
        pulled.notes,
        sync.pathBuilder(pulled.folders),
      );

      set({ index: hydrated.index, coverage: { covered: hydrated.covered, total: hydrated.total } });
    } catch (cause) {
      report(set, cause);
    } finally {
      set({ syncing: false });
    }
  },

  /**
   * Polls while the tab is focused and backs off hard when it is not. Returns the
   * unsubscribe the caller has to run, so a remounted shell does not stack timers.
   */
  startPolling: () => {
    let timer: number | undefined;
    let hint: number | undefined;

    const catchUp = () => get().flushOutbox().then(() => get().syncNow());

    const tick = () => {
      // With no connection the poll becomes the probe: a server that was down and came back
      // fires no browser event, so the only way to learn about it is to keep asking.
      //
      // A live socket slows the poll down but never stops it: the socket is an accelerator,
      // and a hub that dies must cost latency rather than freeze the tree.
      const delay = document.hidden
        ? sync.POLL_HIDDEN_MS
        : !connectivity.isOnline()
          ? sync.POLL_OFFLINE_MS
          : get().live
            ? sync.POLL_LIVE_MS
            : sync.POLL_ACTIVE_MS;

      timer = window.setTimeout(() => {
        void catchUp();
        tick();
      }, delay);
    };

    const onVisible = () => {
      if (!document.hidden) void catchUp();
    };

    // Regaining the network is not the same event as coming back to the tab, and must not be
    // gated on it: a queued write belongs to the user whether or not they are looking.
    const unwatch = connectivity.subscribe((online) => {
      set({ offline: !online });
      if (online) void catchUp();
    });

    liveSession = live.connect({
      changed: (vaultId, changeSeq) => {
        // A hint about a vault this tab is not showing, or about a sequence it has already
        // read, is nothing to do — the second case is the common one, since a write is
        // announced to its own author as well.
        if (get().vaultId !== vaultId || changeSeq <= get().cursor) return;

        // Debounced: a burst that arrives as several frames should still cost one pull.
        window.clearTimeout(hint);
        hint = window.setTimeout(() => void catchUp(), HINT_DEBOUNCE_MS);
      },
      live: (up) => {
        set({ live: up });

        // A reconnect lost the room with the socket. Re-opening asks for whatever arrived
        // while this tab was away, from the sequence it already holds.
        if (up) editing?.session.join();
      },
      frame: (frame) => void editing?.session.receive(frame),
    });

    const vaultId = get().vaultId;
    if (vaultId !== null) liveSession.follow(vaultId);

    set({ offline: !connectivity.isOnline() });

    tick();
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(hint);
      document.removeEventListener('visibilitychange', onVisible);
      unwatch();
      liveSession?.close();
      liveSession = null;
      set({ live: false });
    };
  },

  toggleFolder: (folderId) => {
    const expanded = new Set(get().expanded);
    if (!expanded.delete(folderId)) expanded.add(folderId);

    set({ expanded });
  },

  addFolder: async (parentId, name) => {
    const { vaultId, keyring } = get();
    if (vaultId === null || !keyring || isReadOnly()) return;

    try {
      await ws.createFolder(vaultId, parentId, name, scopeOf(get(), parentId), keyring);
      await get().syncNow();

      if (parentId !== null) {
        const expanded = new Set(get().expanded);
        expanded.add(parentId);
        set({ expanded });
      }
    } catch (cause) {
      reportChange(set, cause);
    }
  },

  addNote: async (folderId, title) => {
    const { vaultId, keyring } = get();
    if (vaultId === null || !keyring || isReadOnly()) return;

    try {
      const note = await ws.createNote(vaultId, folderId, title, scopeOf(get(), folderId), keyring);
      await get().syncNow();
      await get().openNote(note);
      set({ view: 'editor' });
    } catch (cause) {
      reportChange(set, cause);
    }
  },

  openNote: async (note) => {
    const keyring = get().keyring;
    if (!keyring) return;

    try {
      const body = await sync.readBody(note, keyring);

      // The body may be the one this device wrote with no network. Saying so is the
      // difference between "saved" and "saved here, not there yet".
      const queued = await cache.isQueued(note.id).catch(() => false);

      // A note already open keeps its place rather than jumping to the end: a tab strip
      // that reorders itself under the pointer is unusable.
      const tabs = get().tabs.some((tab) => tab.id === note.id)
        ? get().tabs.map((tab) => (tab.id === note.id ? note : tab))
        : fit([...get().tabs, note], note.id);

      set({
        view: 'editor',
        tabs,
        open: {
          note,
          body: body.body,
          contentSeq: body.contentSeq,
          locked: body.locked,
          dirty: false,
          queued,
          conflict: false,
        },
      });
    } catch (cause) {
      // The tree comes from the cache, so a note can be on screen with no network and no
      // copy of its body here. That is a specific thing to say rather than a blank editor.
      if (cause instanceof OfflineError) {
        set({
          error: `“${note.name}” is not on this device yet, and there is no connection to fetch it.`,
        });
        return;
      }

      report(set, cause);
    }
  },

  closeNote: () => {
    get().stopEditing();
    set({ open: null });
  },

  startEditing: async (identity, self) => {
    const { open, keyring, vaultId } = get();

    // No socket means no session, and the note stays on the path it has always had: type,
    // debounce, PUT. That is also what happens when the hub is down.
    //
    // Read-only stays out of the room entirely rather than joining as a watcher: the server
    // names the longest standing member who may write as the committer, and a tab that took
    // that job without writing would leave everybody else's edits in the document with
    // nothing projecting them back into the body.
    if (!open || !keyring || vaultId === null || liveSession === null || open.locked) return;
    if (isReadOnly()) return;
    if (editing?.target.note.id === open.note.id) return;

    get().stopEditing();

    const scope = ws.scopeOfNode(open.note);
    const key = keyring.get(scope.id, scope.version);
    if (!key) return;

    const mine = ++generation;

    // Public keys of everyone who might have written an update, so a signature can be
    // checked before the update is merged. A member this list does not know produces
    // 'unknown-author', which is not applied either.
    const authors = new Map<number, Uint8Array>();

    try {
      const { members } = await collab.listMembers(vaultId);

      for (const member of members) authors.set(member.user_id, b64ToBytes(member.public_key));
    } catch {
      // Without the member list nothing verifies, so nothing is applied. Better than
      // merging text nobody can attribute.
    }

    await settling;

    // Both waits are round trips, and the note on screen may have moved under them — or this
    // start may have been superseded by a later one. A session opened now would be a room
    // nothing closes, holding a sequence for a note the editor no longer shows.
    const onScreen = get().open;
    if (mine !== generation || !onScreen || onScreen.note.id !== open.note.id) return;

    // The sequence comes from the store rather than from `open` above: the session that just
    // stopped writes on its way out, and that write is what moved it.
    const target: CommitTarget = { note: onScreen.note, contentSeq: onScreen.contentSeq };

    const session = createSession({
      note: target.note,
      ref: ws.ref(target.note.vaultId, 'file', target.note.clientId, scope),
      scope: { keyScopeId: scope.id, keyVersion: scope.version },
      key,
      identity,
      self,
      body: onScreen.body,
      contentSeq: target.contentSeq,
      canEdit: target.note.permission !== 'view' && target.note.permission !== 'comment',
      send: (frame) => liveSession?.send(frame),
      authorKey: (userId) => authors.get(userId) ?? null,
      commit: (text, folded) => commitBody(get, set, target, text, folded, identity),
      onBinding: (binding) => set({ collab: binding }),
      onText: (text) => {
        const current = get().open;
        if (!current || current.note.id !== target.note.id) return;

        // The text is the room's, so this is not an unsaved change: it feeds the title, the
        // search index and the wikilinks, and the committer's timer decides when it lands.
        set({ open: { ...current, body: text, dirty: false, conflict: false } });
      },
      onPeers: (peers, committer) => set({ peers, committer }),
      onNotice: (notice) => {
        if (notice.kind === 'reseed') {
          // The document was replaced under this room — an offline body replayed, an older
          // client, or a re-key. Whatever had not been written back is gone from the shared
          // copy, and saying so is better than letting a sentence quietly disappear.
          const current = get().open;
          if (current) set({ open: { ...current, conflict: true } });

          return;
        }

        if (notice.kind === 'unverified') {
          set({ error: 'An edit arrived that could not be verified and was not applied.' });
        }
      },
    });

    editing = { target, session };
    session.join();
  },

  stopEditing: () => {
    // Even with no session up: a start may be suspended on its round trips, and it has to
    // learn that what it was asked for is no longer wanted.
    generation += 1;

    if (!editing) return;

    const closing = editing;
    editing = null;

    // Whatever the room holds beyond the last commit belongs in the body before the tab
    // stops speaking for it. The write outlives this call, and the next session waits for it
    // rather than starting on a sequence it is about to move.
    settling = closing.session
      .flush()
      .catch(() => undefined)
      .finally(() => closing.session.close());

    set({ collab: null, peers: [], committer: false });
  },

  openInBackground: (note) => {
    const { tabs, open } = get();

    if (tabs.some((tab) => tab.id === note.id)) {
      set({ tabs: tabs.map((tab) => (tab.id === note.id ? note : tab)) });
      return;
    }

    set({ tabs: fit([...tabs, note], open?.note.id) });
  },

  moveTab: (noteId, to) => {
    set({ tabs: reorderTabs(get().tabs, noteId, to) });
  },

  editBody: (body) => {
    const open = get().open;
    if (!open || isReadOnly()) return;

    set({ open: { ...open, body, dirty: true, conflict: false } });
  },

  saveNote: async (identity) => {
    const { open, keyring, tree } = get();
    if (!open || !keyring || !open.dirty || open.locked || isReadOnly()) return;

    // With a live session the body is written back by the committer on its own schedule.
    // A second writer here would race the same If-Match and lose, turning every save into
    // a conflict banner.
    if (editing?.target.note.id === open.note.id) return;

    set({ saving: true });

    try {
      const payload = await ws.sealNote(open.note, open.body, open.contentSeq, keyring, identity);
      const contentSeq = await ws.sendNote(open.note.id, payload, open.contentSeq);
      const current = get().open;

      // The write took a round trip, and two things may have moved under it: the user may
      // have opened another note, or kept typing. Stamping the new sequence onto whatever
      // is open now would corrupt a different note's optimistic lock; clearing `dirty`
      // when the body has changed would drop the keystrokes that arrived meanwhile.
      if (current && current.note.id === open.note.id) {
        set({
          open: {
            ...current,
            contentSeq,
            dirty: current.body !== open.body,
            queued: false,
            conflict: false,
          },
        });
      }

      // What was just sent is also what this device should answer with when the network is
      // gone. Writing it here rather than waiting for the index to notice keeps the note
      // readable offline from the moment it is saved. A cache that will not take it costs
      // nothing the server does not already hold, so it is not worth failing the save over.
      await cache
        .writeBodies([
          {
            vaultId: open.note.vaultId,
            id: open.note.id,
            content: payload.content,
            contentNonce: payload.content_nonce,
            contentSeq,
          },
        ])
        .catch(() => undefined);

      // Links are resolved against what this reader can open, so they are recorded from
      // here rather than derived on the server, which holds no titles to match.
      const { resolved } = resolveWikilinks(open.body, tree.notes, open.note.id);

      try {
        await graphApi.setLinks(open.note.id, resolved);
      } catch (cause) {
        // The body is safely written; only the graph is behind. Say so rather than
        // failing the save, and rather than pretending nothing happened.
        report(set, cause);
      }

      await get().syncNow();
    } catch (cause) {
      // A conflict is not an error to shrug off: the body on the server is a version the
      // user has never seen, and nobody but a client can merge the two.
      const current = get().open;

      if (
        cause instanceof ApiError &&
        cause.is(ErrorCode.Conflict) &&
        current &&
        current.note.id === open.note.id
      ) {
        set({ open: { ...current, conflict: true } });
      } else if (cause instanceof OfflineError && open.note.vaultId) {
        // The text is already sealed by the time the network fails, so what goes into the
        // outbox is ciphertext. Losing it here is what "offline" used to mean, and the
        // whole point of the queue is that it no longer does.
        await queue(get, set, open.note.id, identity);
      } else {
        report(set, cause);
      }
    } finally {
      set({ saving: false });
    }
  },

  rename: async (node, kind, name) => {
    await withKeyring(get, set, async (keyring) => {
      await ws.writeMeta(node, kind, { name }, keyring);
      await get().syncNow();

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) {
        set({ open: { ...open, note: { ...open.note, name } } });
      }
    });
  },

  setTags: async (note, tags) => {
    await withKeyring(get, set, async (keyring) => {
      const clean = [...new Set(tags.flatMap((tag) => normalizeTag(tag) ?? []))].slice(0, MAX_TAGS);

      await ws.writeMeta(note, 'file', { tags: clean }, keyring);
      await get().syncNow();

      const open = get().open;
      if (open && open.note.id === note.id) {
        set({ open: { ...open, note: { ...open.note, tags: clean } } });
      }
    });
  },

  setIcon: async (node, kind, icon) => {
    await withKeyring(get, set, async (keyring) => {
      await ws.writeMeta(node, kind, { icon }, keyring);
      await get().syncNow();

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) {
        set({ open: { ...open, note: { ...open.note, icon } } });
      }
    });
  },

  setVaultIcon: async (icon) => {
    await withKeyring(get, set, async (keyring) => {
      const { vaultId, vaults } = get();
      const vault = vaults.find((candidate) => candidate.id === vaultId);
      if (!vault) return;

      await ws.updateVaultMeta(vault, vault.name, icon, keyring);

      // The sync delta carries the tree, not the vault summary, so the list is patched here
      // rather than waiting for a reload to show the icon that was just chosen.
      set({
        vaults: vaults.map((candidate) =>
          candidate.id === vault.id ? { ...candidate, emoji: icon } : candidate,
        ),
      });
    });
  },

  setVaultLabel: async (vaultId, label, identity) => {
    const vault = get().vaults.find((candidate) => candidate.id === vaultId);
    if (!vault || isReadOnly()) return;

    try {
      await ws.setVaultLabel(vault, label, identity);

      // Patched in place rather than re-listing: nothing else about the vault moved, and
      // a full list means decrypting every vault's name again.
      const text = label.trim().slice(0, ws.MAX_LABEL);

      set({
        vaults: get().vaults.map((candidate) =>
          candidate.id === vaultId ? { ...candidate, label: text || undefined } : candidate,
        ),
      });
    } catch (cause) {
      reportChange(set, cause);
    }
  },

  move: async (node, kind, parentId) => {
    const { tree, vaults, vaultId } = get();

    if (isReadOnly()) return;
    if (!movable(tree, vaults.find((vault) => vault.id === vaultId), node, kind, parentId)) return;

    try {
      await ws.moveNode(node, kind, parentId);
      await get().syncNow();

      if (parentId !== null) {
        const expanded = new Set(get().expanded);
        expanded.add(parentId);
        set({ expanded });
      }
    } catch (cause) {
      reportChange(set, cause);
    }
  },

  trash: async (node, kind) => {
    if (isReadOnly()) return;

    try {
      await (kind === 'folder' ? ws.trashFolder(node.id) : ws.trashNote(node.id));

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) set({ open: null });

      await get().syncNow();
    } catch (cause) {
      reportChange(set, cause);
    }
  },

  setView: (view) => set({ view }),
  setQuery: (query) => set({ query, view: query ? 'search' : get().view }),

  rekey: async (target, identity, onProgress) => {
    const { vaultId, vaults, tree, keyring } = get();
    const vault = vaults.find((v) => v.id === vaultId);

    // These two throw rather than returning quietly: a modal is up, it is holding the
    // progress, and it has somewhere to put the reason.
    if (isReadOnly()) throw new Error('Read-only mode is on.');
    if (vaultId === null || !vault || !keyring) throw new Error('open a vault first');

    const plan = await rekeyApi.startRekey(
      vaultId,
      target.scopeType,
      target.scopeRefId,
      target.scopeType === 'vault' ? undefined : crypto.randomUUID(),
    );

    try {
      // The trash is part of the scope even though it is not part of the tree on screen.
      const trashed = await ws.loadTree(vaultId, keyring, true);

      await rekeyApi.runRekey(
        plan,
        {
          vault,
          folders: [...tree.folders, ...trashed.folders],
          notes: [...tree.notes, ...trashed.notes],
        },
        keyring,
        onProgress,
      );
    } catch (cause) {
      // Leaving the job staging would block the node until it expires, and the next attempt
      // would meet a conflict instead of a plan.
      await rekeyApi.abortRekey(plan.id).catch(() => undefined);
      throw cause;
    }

    // The new key exists only on the server now; the keyring has to be re-read before the
    // rows it protects can be opened again.
    set({ keyring: await ws.loadKeyring(vaultId, identity), vaults: await ws.listVaults(identity) });
    await get().syncNow();
  },

  exportVault: async (onProgress) => {
    const { vaultId, vaults, tree, keyring } = get();
    const vault = vaults.find((v) => v.id === vaultId);

    if (!vault || !keyring) throw new Error('open a vault first');

    return transfer.exportVault(vault, tree, keyring, onProgress);
  },

  importVault: async (plan, name, identity, onProgress) => {
    if (isReadOnly()) throw new Error('Read-only mode is on.');

    const report = await transfer.importVault(plan, name, identity, onProgress);

    set({ vaults: await ws.listVaults(identity) });
    await get().selectVault(report.vaultId, identity);

    return report;
  },

  createClaudeVault: async (name, identity, onProgress) =>
    get().importVault(claudeOsPlan(name), name, identity, onProgress),

  flushOutbox: async () => {
    // One drain at a time, and everyone waits on the same one. The poll, the tab coming
    // back and the connection returning can all land together; two of them reading the same
    // queue would send a write twice, and the second copy meets a conflict of its own making
    // and ends up saved as a stray copy.
    // It never rejects either: every caller chains a pull onto it, and a cache that will not
    // open would otherwise take the pull down with it.
    flushing ??= drain(get, set)
      .catch((cause: unknown) => report(set, cause))
      .finally(() => {
        flushing = null;
      });

    return flushing;
  },

  // The server cannot merge two ciphertexts and neither can anybody else automatically, so
  // a conflict leaves the writer holding a version with nowhere to put it. This gives it
  // somewhere: a sibling note, saved under their own name, with nothing overwritten.
  saveAsCopy: async (identity) => {
    const { open, vaultId, keyring } = get();
    if (!open || vaultId === null || !keyring || isReadOnly()) return;

    set({ saving: true });

    try {
      const copy = await ws.createNote(
        vaultId,
        open.note.folderId,
        `${open.note.name} (my version)`,
        scopeOf(get(), open.note.folderId),
        keyring,
      );

      const contentSeq = await ws.writeNote(copy, open.body, copy.contentSeq, keyring, identity);

      await get().syncNow();
      await get().openNote({ ...copy, contentSeq });
      set({ view: 'editor' });
    } catch (cause) {
      reportChange(set, cause);
    } finally {
      set({ saving: false });
    }
  },

  closeTab: (noteId) => {
    const tabs = get().tabs.filter((tab) => tab.id !== noteId);
    const open = get().open;

    set({ tabs });

    // Closing the note on screen moves to its neighbour rather than to nothing: an empty
    // editor after closing one of several tabs reads as having lost them all.
    if (open && open.note.id === noteId) {
      const next = tabs[tabs.length - 1];

      if (next) void get().openNote(next);
      else set({ open: null });
    }
  },

  loadTrash: async () => {
    const { vaultId, keyring } = get();
    if (vaultId === null || !keyring) return;

    try {
      const trashed = await ws.loadTree(vaultId, keyring, true);

      // The read took a round trip; if the reader changed vaults during it, this list
      // belongs to the one they left.
      if (get().vaultId === vaultId) set({ trashed });
    } catch (cause) {
      report(set, cause);
    }
  },

  restore: async (id, kind) => {
    if (isReadOnly()) return;

    try {
      await (kind === 'folder' ? ws.restoreFolder(id) : ws.restoreNote(id));
      await get().loadTrash();
      await get().syncNow();
    } catch (cause) {
      reportChange(set, cause);
    }
  },

  purge: async (id, kind) => {
    if (isReadOnly()) return;

    try {
      await (kind === 'folder' ? ws.purgeFolder(id) : ws.purgeNote(id));
      await get().loadTrash();
      await get().syncNow();
    } catch (cause) {
      reportChange(set, cause);
    }
  },

  reset: async () => {
    await cache.dropAll();

    set({
      vaults: [],
      vaultId: null,
      keyring: null,
      tree: emptyTree,
  trashed: emptyTree,
  tabs: [],
      expanded: new Set(),
      open: null,
      index: [],
      coverage: { covered: 0, total: 0 },
      query: '',
      view: 'editor',
      loaded: false,
      error: null,
    });
  },
}));

type Setter = (partial: Partial<WorkspaceState>) => void;

/** The drain in flight, if any. See `flushOutbox`. */
let flushing: Promise<void> | null = null;

/**
 * Writes back what the live document holds.
 *
 * Only the committer calls this, and only for the note it is committing, so the optimistic
 * lock behaves exactly as it does for a solitary writer: the sequence this tab last saw,
 * against the row the server holds. The difference is what travels beside the body — the
 * document state and the sequence it covers, which is what tells the server this write came
 * *through* the session rather than around it.
 *
 * The note comes from the session rather than from `open`, because the commit that matters
 * most is the one on the way out: it is scheduled while the note is on screen and lands after
 * it has closed. Reading the store then would find another note, or none, and drop the write
 * — leaving the body behind the document until somebody opened the note again.
 *
 * Exported for the test that pins exactly that: the store cannot be driven into the state
 * from the outside, because the live session it needs is opened by `watch`.
 */
export async function commitBody(
  get: () => WorkspaceState,
  set: Setter,
  target: CommitTarget,
  text: string,
  folded: ws.CRDTCommit,
  identity: Identity,
): Promise<void> {
  const { keyring, tree } = get();
  if (!keyring) return;

  const { note } = target;

  set({ saving: true });

  try {
    const sealed = await ws.sealNote(note, text, target.contentSeq, keyring, identity);
    const contentSeq = await ws.sendNote(note.id, ws.withCommit(sealed, folded), target.contentSeq);

    // The next commit of this session locks against what this one wrote, whether or not the
    // note is still open.
    target.contentSeq = contentSeq;

    const current = get().open;
    if (current && current.note.id === note.id) {
      set({ open: { ...current, contentSeq, dirty: false, queued: false, conflict: false } });
    }

    await cache
      .writeBodies([
        {
          vaultId: note.vaultId,
          id: note.id,
          content: sealed.content,
          contentNonce: sealed.content_nonce,
          contentSeq,
        },
      ])
      .catch(() => undefined);

    const { resolved } = resolveWikilinks(text, tree.notes, note.id);
    await graphApi.setLinks(note.id, resolved).catch(() => undefined);
  } catch (cause) {
    // A refused write-back leaves the document as the truth, which is where it already was.
    // The next commit tries again; a conflict is the room being replaced, and the reseed
    // frame is what says so.
    report(set, cause);
  } finally {
    set({ saving: false });
  }
}

/**
 * Sends every body this device wrote with no network, oldest attempt included.
 *
 * A write that the server will never take is not retried forever: it is kept as a note of
 * its own and taken off the queue, because a queue that cannot drain stops being a promise
 * that the work will land.
 */
async function drain(get: () => WorkspaceState, set: Setter): Promise<void> {
  const { vaultId } = get();
  if (vaultId === null || !connectivity.isOnline()) return;

  // Read-only holds the queue rather than dropping it: these are bodies the user wrote
  // before the mode went on, they are still in the cache as ciphertext, and they go out on
  // the first drain after it goes off.
  if (isReadOnly()) return;

  // The queue is read rather than the counter: two tabs share one IndexedDB, and a write
  // parked by the other one is just as much this vault's work.
  const pending = await cache.outbox(vaultId);
  if (pending.length === 0) return;

  for (const write of pending) {
    try {
      const contentSeq = await ws.sendNote(write.id, write.payload, write.contentSeq);

      await cache.dequeue(write.id);

      // The queued ciphertext is now what the server holds, under the sequence it just
      // assigned. Stamping it here keeps the cached body from reading as stale and being
      // fetched straight back — the same bytes, over the network.
      await cache.writeBodies([
        {
          vaultId: write.vaultId,
          id: write.id,
          content: write.payload.content,
          contentNonce: write.payload.content_nonce,
          contentSeq,
        },
      ]);

      const open = get().open;
      if (open && open.note.id === write.id) {
        set({ open: { ...open, contentSeq, queued: false, conflict: false } });
      }
    } catch (cause) {
      // A conflict means somebody wrote while this device was away, and nobody but a client
      // can merge two ciphertexts. Dropping the queued copy would lose work the user did
      // offline and never see again, so it is kept — as a note of its own.
      if (cause instanceof ApiError && cause.is(ErrorCode.Conflict)) {
        await rescue(get, set, write);
        await cache.dequeue(write.id);

        const open = get().open;
        if (open && open.note.id === write.id) set({ open: { ...open, conflict: true } });

        continue;
      }

      // A note that was purged or that this account no longer reaches will refuse this write
      // forever. Retrying it on every reconnect would be a queue that never drains.
      if (cause instanceof ApiError && (cause.status === 404 || cause.status === 403)) {
        await rescue(get, set, write);
        await cache.dequeue(write.id);

        continue;
      }

      // Still offline, or the server is unwell. Leave the rest queued and try later.
      if (cause instanceof OfflineError) break;

      report(set, cause);
    }
  }

  set({ queued: await cache.outboxSize(vaultId) });
}

/** Every verb that writes meta goes through here, and none of them run in read-only. */
async function withKeyring(
  get: () => WorkspaceState,
  set: Setter,
  action: (keyring: ScopeKeyring) => Promise<void>,
): Promise<void> {
  const keyring = get().keyring;
  if (!keyring || isReadOnly()) return;

  try {
    await action(keyring);
  } catch (cause) {
    reportChange(set, cause);
  }
}

function allOpen(folders: ws.FolderNode[]): Set<number> {
  return new Set(folders.map((folder) => folder.id));
}

/**
 * Trims the strip back to MAX_TABS, oldest first but never the note on screen: dropping that
 * one leaves the editor showing a note the strip no longer lists, and no way back to it.
 */
function fit(tabs: ws.NoteNode[], keep: number | undefined): ws.NoteNode[] {
  if (tabs.length <= MAX_TABS) return tabs;

  const oldest = tabs.findIndex((tab) => tab.id !== keep);
  if (oldest < 0) return tabs.slice(-MAX_TABS);

  return fit([...tabs.slice(0, oldest), ...tabs.slice(oldest + 1)], keep);
}

/**
 * The strip with one tab lifted out and set down at `to`, which counts slots in the strip as
 * it stands — a drag reports the slot it is over, not the gap it left behind.
 */
export function reorderTabs(tabs: ws.NoteNode[], noteId: number, to: number): ws.NoteNode[] {
  const from = tabs.findIndex((tab) => tab.id === noteId);
  const moved = tabs[from];
  const target = Math.min(Math.max(to, 0), tabs.length - 1);

  if (!moved || from === target) return tabs;

  const rest = tabs.filter((tab) => tab.id !== noteId);

  return [...rest.slice(0, target), moved, ...rest.slice(target)];
}

/**
 * The key scope a new node inherits: its parent folder's, or the vault's own at the root.
 * Sending the wrong one is refused by the server, because the row would be unreadable.
 */
function scopeOf(state: WorkspaceState, parentId: number | null): ws.Scope {
  if (parentId !== null) {
    const parent = state.tree.folders.find((folder) => folder.id === parentId);
    if (parent) {
      return { id: parent.keyScopeId, clientId: parent.keyScopeClientId, version: parent.keyVersion };
    }
  }

  const vault = state.vaults.find((v) => v.id === state.vaultId);
  if (!vault) throw new Error('no active vault');

  return { id: vault.keyScopeId, clientId: vault.keyScopeClientId, version: vault.keyVersion };
}

// queue parks a body the network refused to take. It is sealed first, so the outbox holds
// ciphertext like every other store here.
/**
 * Keeps a queued body the server will not take, as a note of its own.
 *
 * It is the only place that work can go: the server holds a version this device never saw,
 * merging two ciphertexts is nobody's job, and silently dropping it would lose whatever was
 * written offline with no trace that it existed.
 */
async function rescue(get: () => WorkspaceState, set: Setter, write: cache.Queued): Promise<void> {
  const { keyring, vaultId, tree } = get();
  if (!keyring || vaultId === null) return;

  const note = tree.notes.find((candidate) => candidate.id === write.id);

  // Without the note the additional data cannot be rebuilt, so the ciphertext cannot be
  // opened. Say so rather than pretend the write landed.
  if (!note) {
    set({ error: 'A note written offline could not be restored: it no longer exists.' });
    return;
  }

  try {
    const body = await ws.openBody(
      {
        vault_id: note.vaultId,
        client_id: note.clientId,
        key_scope_id: write.payload.key_scope_id,
        key_scope_client_id: note.keyScopeClientId,
        key_version: write.payload.key_version,
      },
      write.payload.content,
      write.payload.content_nonce,
      keyring,
    );

    if (body === null) {
      set({ error: 'A note written offline could not be restored: its key is gone.' });
      return;
    }

    const copy = await ws.createNote(
      vaultId,
      note.folderId,
      `${note.name} (offline copy)`,
      scopeOf(get(), note.folderId),
      keyring,
    );

    await ws.writeNote(copy, body, copy.contentSeq, keyring);

    set({ error: `“${note.name}” changed while you were offline; your version was kept as a copy.` });
  } catch (cause) {
    report(set, cause);
  }
}

async function queue(
  get: () => WorkspaceState,
  set: Setter,
  noteId: number,
  identity: Identity | undefined,
): Promise<void> {
  const { keyring, vaultId, open } = get();
  if (!keyring || vaultId === null) return;

  // The state is read here rather than passed in: sealing and sending both awaited, and
  // whatever the user typed meanwhile is the version worth keeping. Queueing the snapshot
  // would put the older text in the outbox and revert the editor to match it.
  if (!open || open.note.id !== noteId) return;

  try {
    const payload = await ws.sealNote(open.note, open.body, open.contentSeq, keyring, identity);

    await cache.enqueue({
      id: open.note.id,
      vaultId,
      contentSeq: open.contentSeq,
      payload,
      queuedAt: Date.now(),
    });

    // The same ciphertext also replaces the cached body. Without it, closing the note and
    // coming back offline reads the copy the server last had — the text the user just wrote
    // would be gone from the screen while sitting in the outbox, and typing on top of it
    // would queue the older version back.
    //
    // It keeps the sequence it was sealed against, which is the one the server still holds,
    // so the index does not treat it as behind and fetch it back over the write.
    await cache.writeBodies([
      {
        vaultId,
        id: open.note.id,
        content: payload.content,
        contentNonce: payload.content_nonce,
        contentSeq: open.contentSeq,
      },
    ]);

    const current = get().open;

    // `offline` is not touched here: the failed request already told the connectivity watch,
    // and it is the one thing that decides.
    set({
      queued: await cache.outboxSize(vaultId),
      ...(current && current.note.id === noteId
        ? { open: { ...current, dirty: current.body !== open.body, queued: true } }
        : {}),
    });
  } catch (cause) {
    // The cache is the only place a queued write can live. If it will not take it, saying
    // the note is saved would be a lie.
    report(set, cause);
  }
}

function report(set: Setter, cause: unknown): void {
  // Losing the network is a state, not a failure: the cache still answers reads, the status
  // line already says so, and the next poll picks up where this one stopped.
  if (cause instanceof OfflineError) return;

  set({ error: describe(cause) });
}

/**
 * The same, for a change the user just made rather than for a read.
 *
 * Only note bodies survive a lost network — everything else here is a request and nothing
 * more. Swallowing those the way a failed read is swallowed would leave a folder that was
 * never created, or a rename that never happened, with the tree redrawn as if it had.
 */
function reportChange(set: Setter, cause: unknown): void {
  if (cause instanceof OfflineError) {
    set({
      error: 'No connection. That change was not saved — try it again once you are back online.',
    });
    return;
  }

  report(set, cause);
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case ErrorCode.Forbidden:
        return 'You do not have permission to do that.';
      case ErrorCode.NotFound:
        return 'That item is gone.';
      case ErrorCode.Conflict:
        return 'Someone else changed this first.';
      default:
        return cause.message;
    }
  }

  return cause instanceof Error ? cause.message : 'Something went wrong.';
}

/**
 * Whether a node may be dropped on a folder, or on the root when `targetId` is null.
 *
 * The rule is the server's, asked before the drag rather than after: a destination whose key
 * scope differs would leave the moved ciphertext unreadable to everyone there, and the server
 * answers 409 rather than re-encrypting. Being able to say no while the row is still under the
 * hand is what makes the refusal legible — the alternative is a toast after the drop.
 *
 * The scope test is what stops a node from leaving a folder that owns its key, and stops a
 * folder that owns its own key from being moved at all. That is the model, not an oversight:
 * the ciphertext under it is sealed to that scope.
 */
export function movable(
  tree: ws.Tree,
  vault: ws.Vault | undefined,
  node: ws.FolderNode | ws.NoteNode,
  kind: 'folder' | 'file',
  targetId: number | null,
): boolean {
  if (!vault || node.locked || !writable(node.permission)) return false;

  const from = kind === 'folder' ? (node as ws.FolderNode).parentId : (node as ws.NoteNode).folderId;
  if (from === targetId) return false;

  const target = targetId === null ? null : tree.folders.find((folder) => folder.id === targetId);
  if (targetId !== null && !target) return false;

  if (target ? target.locked || !writable(target.permission) : vault.role === 'viewer') return false;

  // A folder cannot swallow itself, nor land anywhere inside its own subtree.
  if (kind === 'folder' && target && descends(tree, target, node.id)) return false;

  const destination = target ?? vault;

  return destination.keyScopeId === node.keyScopeId && destination.keyVersion === node.keyVersion;
}

function writable(permission: ws.Permission): boolean {
  return permission === 'edit' || permission === 'own';
}

/** True when `folder` is `ancestorId` or sits under it. Bounded by the depth the server allows. */
function descends(tree: ws.Tree, folder: ws.FolderNode, ancestorId: number): boolean {
  let current: ws.FolderNode | undefined = folder;

  for (let step = 0; current && step <= MAX_DEPTH; step += 1) {
    if (current.id === ancestorId) return true;

    const parentId: number | null = current.parentId;
    current = parentId === null ? undefined : tree.folders.find((f) => f.id === parentId);
  }

  return false;
}

/** Builds the tree the sidebar renders, in the order the design shows it. */
export interface TreeRow {
  kind: 'folder' | 'note';
  node: ws.FolderNode | ws.NoteNode;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export function treeRows(tree: ws.Tree, expanded: Set<number>): TreeRow[] {
  const childFolders = new Map<number | null, ws.FolderNode[]>();
  for (const folder of tree.folders) {
    const siblings = childFolders.get(folder.parentId) ?? [];
    siblings.push(folder);
    childFolders.set(folder.parentId, siblings);
  }

  const childNotes = new Map<number | null, ws.NoteNode[]>();
  for (const note of tree.notes) {
    const siblings = childNotes.get(note.folderId) ?? [];
    siblings.push(note);
    childNotes.set(note.folderId, siblings);
  }

  const rows: TreeRow[] = [];

  const walk = (parentId: number | null, depth: number) => {
    for (const folder of childFolders.get(parentId) ?? []) {
      const hasChildren =
        (childFolders.get(folder.id)?.length ?? 0) + (childNotes.get(folder.id)?.length ?? 0) > 0;
      const isOpen = expanded.has(folder.id);

      rows.push({ kind: 'folder', node: folder, depth, hasChildren, expanded: isOpen });

      if (isOpen) walk(folder.id, depth + 1);
    }

    for (const note of childNotes.get(parentId) ?? []) {
      rows.push({ kind: 'note', node: note, depth, hasChildren: false, expanded: false });
    }
  };

  walk(null, 0);

  return rows;
}
