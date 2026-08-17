import { create } from 'zustand';

import { ApiError, OfflineError } from '@/api/client';
import { ErrorCode } from '@/api/types';
import * as collab from '@/api/collab';
import * as graphApi from '@/api/graph';
import * as rekeyApi from '@/api/rekey';
import * as ws from '@/api/workspace';
import type { Identity } from '@/crypto/identity';
import type { ScopeKeyring } from '@/crypto/keyring';
import * as cache from '@/db/cache';
import { normalizeTag, type IndexedNote } from '@/lib/search';
import { resolveWikilinks } from '@/lib/wikilinks';
import * as sync from '@/sync/engine';

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

export type View = 'editor' | 'search' | 'graph' | 'trash';

// MAX_TABS bounds the strip. Past a dozen the labels are unreadable and the strip stops
// being a way back to anything.
const MAX_TABS = 12;

// Meta is one ciphertext the server caps at 8 KiB. A note that cannot be saved because of
// its tag list would be the worst way to find that out, so the list is bounded well short.
const MAX_TAGS = 24;

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
  offline: boolean;
  /** Bodies written with no network, waiting to be sent. */
  queued: number;
  error: string | null;

  load: (identity: Identity) => Promise<void>;
  selectVault: (vaultId: number, identity: Identity) => Promise<void>;
  createVault: (name: string, identity: Identity) => Promise<void>;
  /**
   * Destroys a vault of one's own, or walks out of somebody else's. Both end the same way
   * here — the vault is gone from this account — so they share the aftermath.
   */
  removeVault: (vaultId: number, mode: 'delete' | 'leave', identity: Identity) => Promise<void>;
  syncNow: () => Promise<void>;
  startPolling: () => () => void;
  toggleFolder: (folderId: number) => void;
  addFolder: (parentId: number | null, name: string) => Promise<void>;
  addNote: (folderId: number | null, title: string) => Promise<void>;
  openNote: (note: ws.NoteNode) => Promise<void>;
  editBody: (body: string) => void;
  saveNote: (identity?: Identity) => Promise<void>;
  /** Replays every body written while the network was gone. */
  flushOutbox: () => Promise<void>;
  rename: (node: ws.FolderNode | ws.NoteNode, kind: 'folder' | 'file', name: string) => Promise<void>;
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
}

const emptyTree: ws.Tree = { folders: [], notes: [] };

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
  offline: false,
  queued: 0,
  error: null,

  load: async (identity) => {
    set({ loading: true, error: null });

    try {
      const vaults = await ws.listVaults(identity);
      set({ vaults, loaded: true });

      const first = vaults[0];
      if (first && get().vaultId === null) await get().selectVault(first.id, identity);
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
      error: null,
    });

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
    set({ loading: true, error: null });

    try {
      const created = await ws.createVault(name, undefined, identity);
      set({ vaults: await ws.listVaults(identity) });
      await get().selectVault(created.id, identity);
    } catch (cause) {
      report(set, cause);
    } finally {
      set({ loading: false });
    }
  },

  removeVault: async (vaultId, mode, identity) => {
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
      report(set, cause);
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
        offline: false,
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

    const tick = () => {
      const delay = document.hidden ? sync.POLL_HIDDEN_MS : sync.POLL_ACTIVE_MS;

      timer = window.setTimeout(() => {
        if (navigator.onLine) void get().flushOutbox().then(() => get().syncNow());
        tick();
      }, delay);
    };

    const onVisible = () => {
      if (!document.hidden) void get().flushOutbox().then(() => get().syncNow());
    };

    // Regaining the network is not the same event as coming back to the tab, and must not
    // be gated on it: a queued write belongs to the user whether or not they are looking.
    const onOnline = () => {
      void get().flushOutbox();
    };

    tick();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  },

  toggleFolder: (folderId) => {
    const expanded = new Set(get().expanded);
    if (!expanded.delete(folderId)) expanded.add(folderId);

    set({ expanded });
  },

  addFolder: async (parentId, name) => {
    const { vaultId, keyring } = get();
    if (vaultId === null || !keyring) return;

    try {
      await ws.createFolder(vaultId, parentId, name, scopeOf(get(), parentId), keyring);
      await get().syncNow();

      if (parentId !== null) {
        const expanded = new Set(get().expanded);
        expanded.add(parentId);
        set({ expanded });
      }
    } catch (cause) {
      report(set, cause);
    }
  },

  addNote: async (folderId, title) => {
    const { vaultId, keyring } = get();
    if (vaultId === null || !keyring) return;

    try {
      const note = await ws.createNote(vaultId, folderId, title, scopeOf(get(), folderId), keyring);
      await get().syncNow();
      await get().openNote(note);
      set({ view: 'editor' });
    } catch (cause) {
      report(set, cause);
    }
  },

  openNote: async (note) => {
    const keyring = get().keyring;
    if (!keyring) return;

    try {
      const body = await ws.readNote(note.id, keyring);

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
          conflict: false,
        },
      });
    } catch (cause) {
      report(set, cause);
    }
  },

  openInBackground: (note) => {
    const { tabs, open } = get();

    if (tabs.some((tab) => tab.id === note.id)) {
      set({ tabs: tabs.map((tab) => (tab.id === note.id ? note : tab)) });
      return;
    }

    set({ tabs: fit([...tabs, note], open?.note.id) });
  },

  editBody: (body) => {
    const open = get().open;
    if (!open) return;

    set({ open: { ...open, body, dirty: true, conflict: false } });
  },

  saveNote: async (identity) => {
    const { open, keyring, tree } = get();
    if (!open || !keyring || !open.dirty || open.locked) return;

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
            conflict: false,
          },
        });
      }

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
    if (!vault) return;

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
      report(set, cause);
    }
  },

  trash: async (node, kind) => {
    try {
      await (kind === 'folder' ? ws.trashFolder(node.id) : ws.trashNote(node.id));

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) set({ open: null });

      await get().syncNow();
    } catch (cause) {
      report(set, cause);
    }
  },

  setView: (view) => set({ view }),
  setQuery: (query) => set({ query, view: query ? 'search' : get().view }),

  rekey: async (target, identity, onProgress) => {
    const { vaultId, vaults, tree, keyring } = get();
    const vault = vaults.find((v) => v.id === vaultId);

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

  flushOutbox: async () => {
    const { vaultId } = get();
    if (vaultId === null || !navigator.onLine) return;

    // The queue is read rather than the counter: two tabs share one IndexedDB, and a write
    // parked by the other one is just as much this vault's work.
    const pending = await cache.outbox(vaultId);
    if (pending.length === 0) return;

    for (const write of pending) {
      try {
        const contentSeq = await ws.sendNote(write.id, write.payload, write.contentSeq);

        await cache.dequeue(write.id);

        const open = get().open;
        if (open && open.note.id === write.id) {
          set({ open: { ...open, contentSeq, conflict: false } });
        }
      } catch (cause) {
        // A conflict means somebody wrote while this device was away, and nobody but a
        // client can merge two ciphertexts. Dropping the queued copy would lose work the
        // user did offline and never see again, so it is kept — as a note of its own.
        if (cause instanceof ApiError && cause.is(ErrorCode.Conflict)) {
          await rescue(get, set, write);
          await cache.dequeue(write.id);

          const open = get().open;
          if (open && open.note.id === write.id) set({ open: { ...open, conflict: true } });

          continue;
        }

        // A note that was purged or that this account no longer reaches will refuse this
        // write forever. Retrying it on every reconnect would be a queue that never drains.
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

    set({ queued: await cache.outboxSize(vaultId), offline: false });
    await get().syncNow();
  },

  // The server cannot merge two ciphertexts and neither can anybody else automatically, so
  // a conflict leaves the writer holding a version with nowhere to put it. This gives it
  // somewhere: a sibling note, saved under their own name, with nothing overwritten.
  saveAsCopy: async (identity) => {
    const { open, vaultId, keyring } = get();
    if (!open || vaultId === null || !keyring) return;

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
      report(set, cause);
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
    try {
      await (kind === 'folder' ? ws.restoreFolder(id) : ws.restoreNote(id));
      await get().loadTrash();
      await get().syncNow();
    } catch (cause) {
      report(set, cause);
    }
  },

  purge: async (id, kind) => {
    try {
      await (kind === 'folder' ? ws.purgeFolder(id) : ws.purgeNote(id));
      await get().loadTrash();
      await get().syncNow();
    } catch (cause) {
      report(set, cause);
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

async function withKeyring(
  get: () => WorkspaceState,
  set: Setter,
  action: (keyring: ScopeKeyring) => Promise<void>,
): Promise<void> {
  const keyring = get().keyring;
  if (!keyring) return;

  try {
    await action(keyring);
  } catch (cause) {
    report(set, cause);
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
  if (!open || open.note.id !== noteId) {
    set({ offline: true });
    return;
  }

  try {
    await cache.enqueue({
      id: open.note.id,
      vaultId,
      contentSeq: open.contentSeq,
      payload: await ws.sealNote(open.note, open.body, open.contentSeq, keyring, identity),
      queuedAt: Date.now(),
    });

    const current = get().open;

    set({
      offline: true,
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
  // Losing the network is a state, not a failure: the cache still answers reads and the
  // next poll picks up where this one stopped.
  if (cause instanceof OfflineError) {
    set({ offline: true });
    return;
  }

  set({ error: describe(cause) });
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
