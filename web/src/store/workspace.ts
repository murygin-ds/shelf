import { create } from 'zustand';

import { ApiError } from '@/api/client';
import { ErrorCode } from '@/api/types';
import * as ws from '@/api/workspace';
import type { ScopeKeyring } from '@/crypto/keyring';
import type { Identity } from '@/crypto/identity';

export interface OpenNote {
  note: ws.NoteNode;
  body: string;
  contentSeq: number;
  locked: boolean;
  dirty: boolean;
  /** Set when the server refused a write because someone else got there first. */
  conflict: boolean;
}

interface WorkspaceState {
  vaults: ws.Vault[];
  vaultId: number | null;
  keyring: ScopeKeyring | null;
  tree: ws.Tree;
  expanded: Set<number>;
  open: OpenNote | null;
  loading: boolean;
  saving: boolean;
  error: string | null;

  load: (identity: Identity) => Promise<void>;
  selectVault: (vaultId: number, identity: Identity) => Promise<void>;
  createVault: (name: string, identity: Identity) => Promise<void>;
  refreshTree: () => Promise<void>;
  toggleFolder: (folderId: number) => void;
  addFolder: (parentId: number | null, name: string) => Promise<void>;
  addNote: (folderId: number | null, title: string) => Promise<void>;
  openNote: (note: ws.NoteNode) => Promise<void>;
  editBody: (body: string) => void;
  saveNote: () => Promise<void>;
  rename: (node: ws.FolderNode | ws.NoteNode, kind: 'folder' | 'file', name: string) => Promise<void>;
  setIcon: (node: ws.FolderNode | ws.NoteNode, kind: 'folder' | 'file', icon: string | undefined) => Promise<void>;
  trash: (node: ws.FolderNode | ws.NoteNode, kind: 'folder' | 'file') => Promise<void>;
  reset: () => void;
}

const emptyTree: ws.Tree = { folders: [], notes: [] };

export const useWorkspace = create<WorkspaceState>((set, get) => ({
  vaults: [],
  vaultId: null,
  keyring: null,
  tree: emptyTree,
  expanded: new Set(),
  open: null,
  loading: false,
  saving: false,
  error: null,

  load: async (identity) => {
    set({ loading: true, error: null });

    try {
      const vaults = await ws.listVaults(identity);
      set({ vaults });

      const first = vaults[0];
      if (first && get().vaultId === null) {
        await get().selectVault(first.id, identity);
      }
    } catch (cause) {
      set({ error: describe(cause) });
    } finally {
      set({ loading: false });
    }
  },

  selectVault: async (vaultId, identity) => {
    set({ loading: true, vaultId, open: null, tree: emptyTree, error: null });

    try {
      const keyring = await ws.loadKeyring(vaultId, identity);
      const tree = await ws.loadTree(vaultId, keyring);

      // Everything with children starts open: the design shows an expanded tree, and a
      // vault whose contents are hidden on arrival reads as an empty one.
      const expanded = new Set(tree.folders.map((folder) => folder.id));

      set({ keyring, tree, expanded });
    } catch (cause) {
      set({ error: describe(cause) });
    } finally {
      set({ loading: false });
    }
  },

  createVault: async (name, identity) => {
    set({ loading: true, error: null });

    try {
      const created = await ws.createVault(name, undefined, identity);
      const vaults = await ws.listVaults(identity);

      set({ vaults });
      await get().selectVault(created.id, identity);
    } catch (cause) {
      set({ error: describe(cause) });
    } finally {
      set({ loading: false });
    }
  },

  refreshTree: async () => {
    const { vaultId, keyring } = get();
    if (vaultId === null || !keyring) return;

    try {
      set({ tree: await ws.loadTree(vaultId, keyring) });
    } catch (cause) {
      set({ error: describe(cause) });
    }
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
      await get().refreshTree();

      if (parentId !== null) {
        const expanded = new Set(get().expanded);
        expanded.add(parentId);
        set({ expanded });
      }
    } catch (cause) {
      set({ error: describe(cause) });
    }
  },

  addNote: async (folderId, title) => {
    const { vaultId, keyring } = get();
    if (vaultId === null || !keyring) return;

    try {
      const note = await ws.createNote(vaultId, folderId, title, scopeOf(get(), folderId), keyring);
      await get().refreshTree();
      await get().openNote(note);
    } catch (cause) {
      set({ error: describe(cause) });
    }
  },

  openNote: async (note) => {
    const { keyring } = get();
    if (!keyring) return;

    try {
      const body = await ws.readNote(note.id, keyring);

      set({
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
      set({ error: describe(cause) });
    }
  },

  editBody: (body) => {
    const open = get().open;
    if (!open) return;

    set({ open: { ...open, body, dirty: true, conflict: false } });
  },

  saveNote: async () => {
    const { open, keyring } = get();
    if (!open || !keyring || !open.dirty || open.locked) return;

    set({ saving: true });

    try {
      const contentSeq = await ws.writeNote(open.note, open.body, open.contentSeq, keyring);

      set({ open: { ...get().open!, contentSeq, dirty: false, conflict: false } });
    } catch (cause) {
      // A conflict is not an error to shrug off: the body on the server is a version the
      // user has never seen, and nobody but a client can merge the two.
      if (cause instanceof ApiError && cause.is(ErrorCode.Conflict)) {
        set({ open: { ...get().open!, conflict: true } });
      } else {
        set({ error: describe(cause) });
      }
    } finally {
      set({ saving: false });
    }
  },

  rename: async (node, kind, name) => {
    const keyring = get().keyring;
    if (!keyring) return;

    try {
      await ws.renameNode(node, kind, name, node.icon, keyring);
      await get().refreshTree();

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) {
        set({ open: { ...open, note: { ...open.note, name } } });
      }
    } catch (cause) {
      set({ error: describe(cause) });
    }
  },

  setIcon: async (node, kind, icon) => {
    const keyring = get().keyring;
    if (!keyring) return;

    try {
      await ws.renameNode(node, kind, node.name, icon, keyring);
      await get().refreshTree();

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) {
        set({ open: { ...open, note: { ...open.note, icon } } });
      }
    } catch (cause) {
      set({ error: describe(cause) });
    }
  },

  trash: async (node, kind) => {
    try {
      await (kind === 'folder' ? ws.trashFolder(node.id) : ws.trashNote(node.id));

      const open = get().open;
      if (open && kind === 'file' && open.note.id === node.id) set({ open: null });

      await get().refreshTree();
    } catch (cause) {
      set({ error: describe(cause) });
    }
  },

  reset: () =>
    set({
      vaults: [],
      vaultId: null,
      keyring: null,
      tree: emptyTree,
      expanded: new Set(),
      open: null,
      error: null,
    }),
}));

/**
 * The key scope a new node inherits: its parent folder's, or the vault's own at the root.
 * Sending the wrong one is refused by the server, because the row would be unreadable.
 */
function scopeOf(state: WorkspaceState, parentId: number | null): ws.Scope {
  if (parentId !== null) {
    const parent = state.tree.folders.find((folder) => folder.id === parentId);
    if (parent) return { id: parent.keyScopeId, version: parent.keyVersion };
  }

  const vault = state.vaults.find((v) => v.id === state.vaultId);
  if (!vault) throw new Error('no active vault');

  return { id: vault.keyScopeId, version: vault.keyVersion };
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
