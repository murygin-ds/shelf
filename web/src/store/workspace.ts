import { create } from 'zustand';

import { ApiError, OfflineError } from '@/api/client';
import { ErrorCode } from '@/api/types';
import * as graphApi from '@/api/graph';
import * as rekeyApi from '@/api/rekey';
import * as ws from '@/api/workspace';
import type { Identity } from '@/crypto/identity';
import type { ScopeKeyring } from '@/crypto/keyring';
import * as cache from '@/db/cache';
import type { IndexedNote } from '@/lib/search';
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

export type View = 'editor' | 'search' | 'graph';

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
  trash: (node: ws.FolderNode | ws.NoteNode, kind: 'folder' | 'file') => Promise<void>;
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
  expanded: new Set(),
  open: null,
  view: 'editor',
  query: '',
  index: [],
  coverage: { covered: 0, total: 0 },
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
      set({ vaults });

      const first = vaults[0];
      if (first && get().vaultId === null) await get().selectVault(first.id, identity);
    } catch (cause) {
      report(set, cause);
    } finally {
      set({ loading: false });
    }
  },

  selectVault: async (vaultId, identity) => {
    set({ loading: true, vaultId, open: null, tree: emptyTree, index: [], error: null });

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

      // A note open in the editor may have been purged or trashed elsewhere.
      const open = get().open;
      if (open && !tree.notes.some((note) => note.id === open.note.id)) set({ open: null });

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

      set({
        view: 'editor',
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

      if (cause instanceof ApiError && cause.is(ErrorCode.Conflict) && current) {
        set({ open: { ...current, conflict: true } });
      } else if (cause instanceof OfflineError && open.note.vaultId) {
        // The text is already sealed by the time the network fails, so what goes into the
        // outbox is ciphertext. Losing it here is what "offline" used to mean, and the
        // whole point of the queue is that it no longer does.
        await queue(get, set, open, identity);
      } else {
        report(set, cause);
      }
    } finally {
      set({ saving: false });
    }
  },

  rename: async (node, kind, name) => {
    await withKeyring(get, set, async (keyring) => {
      await ws.renameNode(node, kind, name, node.icon, keyring);
      await get().syncNow();

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) {
        set({ open: { ...open, note: { ...open.note, name } } });
      }
    });
  },

  setIcon: async (node, kind, icon) => {
    await withKeyring(get, set, async (keyring) => {
      await ws.renameNode(node, kind, node.name, icon, keyring);
      await get().syncNow();

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) {
        set({ open: { ...open, note: { ...open.note, icon } } });
      }
    });
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
    const { vaultId, queued } = get();
    if (vaultId === null || queued === 0 || !navigator.onLine) return;

    for (const write of await cache.outbox(vaultId)) {
      try {
        const contentSeq = await ws.sendNote(write.id, write.payload, write.contentSeq);

        await cache.dequeue(write.id);

        const open = get().open;
        if (open && open.note.id === write.id) {
          set({ open: { ...open, contentSeq, conflict: false } });
        }
      } catch (cause) {
        // A conflict means somebody wrote while this device was away, and nobody but a
        // client can merge two ciphertexts. The queued copy is dropped rather than kept
        // forever: it would be replayed on every reconnect and refused every time.
        if (cause instanceof ApiError && cause.is(ErrorCode.Conflict)) {
          await cache.dequeue(write.id);

          const open = get().open;
          if (open && open.note.id === write.id) set({ open: { ...open, conflict: true } });

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

  reset: async () => {
    await cache.dropAll();

    set({
      vaults: [],
      vaultId: null,
      keyring: null,
      tree: emptyTree,
      expanded: new Set(),
      open: null,
      index: [],
      coverage: { covered: 0, total: 0 },
      query: '',
      view: 'editor',
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
async function queue(
  get: () => WorkspaceState,
  set: Setter,
  open: OpenNote,
  identity: Identity | undefined,
): Promise<void> {
  const { keyring, vaultId } = get();
  if (!keyring || vaultId === null) return;

  try {
    await cache.enqueue({
      id: open.note.id,
      vaultId,
      contentSeq: open.contentSeq,
      payload: await ws.sealNote(open.note, open.body, open.contentSeq, keyring, identity),
      queuedAt: Date.now(),
    });

    set({
      offline: true,
      queued: await cache.outboxSize(vaultId),
      open: { ...open, dirty: false, queued: true },
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
