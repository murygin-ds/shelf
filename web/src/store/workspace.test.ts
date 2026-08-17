import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CRDTCommit, FolderNode, NoteNode, Tree, Vault } from '@/api/workspace';
import { generateKey } from '@/crypto/aead';
import { generateIdentity } from '@/crypto/identity';
import type { Identity } from '@/crypto/identity';
import { ScopeKeyring } from '@/crypto/keyring';

import { commitBody, movable, reorderTabs, treeRows } from './workspace';

/**
 * The write-back a live session performs.
 *
 * The commit that matters most is the last one, and it lands after the note has closed —
 * `stopEditing` flushes and the editor moves on without waiting. A write-back that read the
 * note off the store would find `open` already null and drop it, leaving `files.content`
 * behind the document for search, revisions and offline reading.
 */

const SCOPE = { id: 3, clientId: 'ba5eba11-0000-4000-8000-000000000001', version: 2 };

let sent: Array<{ path: string; ifMatch?: string | undefined; body: Record<string, unknown> }> = [];
let sequence = 0;

beforeEach(() => {
  sent = [];
  sequence = 4;

  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

    // The links are written on the same trip, to `/files/88/links`, and answer nothing the
    // caller reads; only the body write moves the sequence.
    if (!String(url).endsWith('/files/88/content')) {
      return Promise.resolve(new Response('{}', { status: 200 }));
    }

    sent.push({
      path: String(url),
      ifMatch: (init.headers as Record<string, string> | undefined)?.['If-Match'],
      body,
    });

    sequence += 1;

    return Promise.resolve(
      new Response(JSON.stringify({ content_seq: sequence }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function note(): NoteNode {
  return {
    id: 88,
    clientId: '8f14e45f-ceea-467a-9f6b-1d2c3b4a5e60',
    vaultId: 12,
    keyScopeClientId: SCOPE.clientId,
    keyScopeId: SCOPE.id,
    keyVersion: SCOPE.version,
    name: 'Roadmap',
    locked: false,
    permission: 'edit',
  } as unknown as NoteNode;
}

function folded(): CRDTCommit {
  return {
    epoch: 1,
    uptoSeq: 17,
    snapshot: { ciphertext: Uint8Array.of(1, 2, 3), nonce: Uint8Array.of(4, 5, 6) },
  };
}

async function identity(): Promise<Identity> {
  return (await generateIdentity(await generateKey())).identity;
}

/** A store with nothing open, which is what a commit on the way out meets. */
async function store(open: unknown = null) {
  const ring = new ScopeKeyring();
  ring.add(SCOPE.id, SCOPE.version, await generateKey());

  const state = { keyring: ring, tree: { folders: [], notes: [] }, open, saving: false };
  const writes: Array<Record<string, unknown>> = [];

  return {
    state,
    writes,
    // The store's own types are private to the module; the seams commitBody takes are the
    // only thing this test needs from them.
    get: (() => state) as unknown as Parameters<typeof commitBody>[0],
    set: ((partial: Record<string, unknown>) => {
      writes.push(partial);
      Object.assign(state, partial);
    }) as unknown as Parameters<typeof commitBody>[1],
  };
}

describe('moving a tab', () => {
  const strip = (...ids: number[]) => ids.map((id) => ({ id }) as NoteNode);
  const ids = (tabs: NoteNode[]) => tabs.map((tab) => tab.id);

  it('lands on the slot it was dropped on, in either direction', () => {
    expect(ids(reorderTabs(strip(1, 2, 3, 4), 1, 2))).toEqual([2, 3, 1, 4]);
    expect(ids(reorderTabs(strip(1, 2, 3, 4), 4, 1))).toEqual([1, 4, 2, 3]);
  });

  it('keeps the strip as it is when nothing moves', () => {
    const tabs = strip(1, 2, 3);

    expect(reorderTabs(tabs, 2, 1)).toBe(tabs);
    expect(reorderTabs(tabs, 9, 0)).toBe(tabs);
  });

  it('clamps a slot past either end', () => {
    expect(ids(reorderTabs(strip(1, 2, 3), 3, 7))).toEqual([1, 2, 3]);
    expect(ids(reorderTabs(strip(1, 2, 3), 3, -2))).toEqual([3, 1, 2]);
  });
});

describe('the sidebar tree', () => {
  const folder = (id: number, parentId: number | null) => ({ id, parentId }) as FolderNode;
  const file = (id: number, folderId: number | null) => ({ id, folderId }) as NoteNode;

  const tree: Tree = {
    folders: [folder(1, null), folder(2, 1), folder(3, 2)],
    notes: [file(10, 3), file(11, null)],
  };

  it('descends into nested folders, one indent per level', () => {
    const rows = treeRows(tree, new Set([1, 2, 3]));

    expect(rows.map((row) => [row.node.id, row.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 2],
      [10, 3],
      [11, 0],
    ]);
    expect(rows.filter((row) => row.hasChildren).map((row) => row.node.id)).toEqual([1, 2, 3]);
  });

  it('leaves the subtree of a collapsed folder undrawn', () => {
    const rows = treeRows(tree, new Set([1]));

    expect(rows.map((row) => row.node.id)).toEqual([1, 2, 11]);

    // The chevron survives the collapse: the folder still has children, they are just not
    // on screen, and a row without one cannot be opened again.
    expect(rows.find((row) => row.node.id === 2)).toMatchObject({
      hasChildren: true,
      expanded: false,
    });
  });
});

describe('where a dragged row may land', () => {
  // One vault scope, version 1, shared by everything that has not been given its own key.
  const ROOT = { keyScopeId: 1, keyVersion: 1, role: 'editor' } as unknown as Vault;

  const folder = (id: number, parentId: number | null, over: Partial<FolderNode> = {}) =>
    ({
      id,
      parentId,
      keyScopeId: 1,
      keyVersion: 1,
      permission: 'edit',
      locked: false,
      ...over,
    }) as FolderNode;

  const file = (id: number, folderId: number | null, over: Partial<NoteNode> = {}) =>
    ({
      id,
      folderId,
      keyScopeId: 1,
      keyVersion: 1,
      permission: 'edit',
      locked: false,
      ...over,
    }) as NoteNode;

  // 1 → 2 → 3, plus a sealed folder holding its own key and a note at the root.
  const sealed = folder(4, null, { keyScopeId: 9, keyVersion: 1, ownScope: true });
  const tree: Tree = {
    folders: [folder(1, null), folder(2, 1), folder(3, 2), sealed],
    notes: [file(10, null), file(11, 1)],
  };

  it('accepts a note into a folder and back out to the root', () => {
    expect(movable(tree, ROOT, file(10, null), 'file', 1)).toBe(true);
    expect(movable(tree, ROOT, file(11, 1), 'file', null)).toBe(true);
  });

  it('refuses a move that changes nothing', () => {
    expect(movable(tree, ROOT, file(11, 1), 'file', 1)).toBe(false);
    expect(movable(tree, ROOT, folder(2, 1), 'folder', 1)).toBe(false);
  });

  it('refuses a folder into itself or its own subtree', () => {
    expect(movable(tree, ROOT, folder(1, null), 'folder', 1)).toBe(false);
    expect(movable(tree, ROOT, folder(1, null), 'folder', 3)).toBe(false);

    // The other direction is a real move: a child may come out to sit beside its parent.
    expect(movable(tree, ROOT, folder(3, 2), 'folder', null)).toBe(true);
  });

  it('refuses to cross a key scope in either direction', () => {
    // The server answers 409 rather than re-encrypting, so the drop never leaves the browser.
    expect(movable(tree, ROOT, file(10, null), 'file', 4)).toBe(false);
    expect(movable(tree, ROOT, sealed, 'folder', 1)).toBe(false);

    // And a note sealed under that folder's key cannot be carried out of it.
    const inside = file(12, 4, { keyScopeId: 9 });
    expect(movable({ ...tree, notes: [inside] }, ROOT, inside, 'file', null)).toBe(false);
  });

  it('refuses what the viewer holds no key or no permission for', () => {
    expect(movable(tree, ROOT, file(10, null, { locked: true }), 'file', 1)).toBe(false);
    expect(movable(tree, ROOT, file(10, null, { permission: 'view' }), 'file', 1)).toBe(false);

    const readOnly = folder(5, null, { permission: 'comment' });
    const withReadOnly = { ...tree, folders: [...tree.folders, readOnly] };
    expect(movable(withReadOnly, ROOT, file(10, null), 'file', 5)).toBe(false);

    // A viewer on the vault cannot drop anything at the root either.
    expect(movable(tree, { ...ROOT, role: 'viewer' }, file(11, 1), 'file', null)).toBe(false);
  });

  it('refuses a destination that is not there', () => {
    expect(movable(tree, ROOT, file(10, null), 'file', 77)).toBe(false);
    expect(movable(tree, undefined, file(10, null), 'file', 1)).toBe(false);
  });
});

describe('the live write-back', () => {
  it('writes the body after the note has been closed', async () => {
    const { get, set } = await store();
    const target = { note: note(), contentSeq: 4 };

    await commitBody(get, set, target, 'ship on tuesday', folded(), await identity());

    expect(sent[0]?.path).toContain('/files/88');
    expect(sent[0]?.ifMatch).toBe('4');

    // The document state travels beside the body: it is what tells the server this write
    // came through the session rather than around it, so the log is folded and not dropped.
    expect(sent[0]?.body).toMatchObject({ crdt_epoch: 1, crdt_upto_seq: 17 });
  });

  it('locks the next commit against the sequence the last one returned', async () => {
    const { get, set } = await store();
    const target = { note: note(), contentSeq: 4 };
    const signer = await identity();

    await commitBody(get, set, target, 'first', folded(), signer);
    await commitBody(get, set, target, 'second', folded(), signer);

    expect(target.contentSeq).toBe(6);
    expect(sent.map((write) => write.ifMatch)).toEqual(['4', '5']);
  });

  it('stamps the new sequence on the note only while it is the one on screen', async () => {
    const open = { note: note(), body: 'ship on tuesday', contentSeq: 4, dirty: true };
    const { get, set, writes } = await store(open);

    await commitBody(get, set, { note: note(), contentSeq: 4 }, 'ship on tuesday', folded(), await identity());

    expect(writes.some((write) => write.open)).toBe(true);
    expect((get() as unknown as { open: { contentSeq: number; dirty: boolean } }).open).toMatchObject({
      contentSeq: 5,
      dirty: false,
    });

    // Another note took the editor while the write was in flight: stamping this sequence on
    // it would corrupt a lock that belongs to a different row.
    const other = await store({ note: { ...note(), id: 91 }, contentSeq: 2 });

    await commitBody(other.get, other.set, { note: note(), contentSeq: 5 }, 'later', folded(), await identity());

    expect(other.writes.some((write) => write.open)).toBe(false);
  });
});
