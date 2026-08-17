import { OfflineError } from '@/api/client';
import type { FileDto, FolderDto } from '@/api/workspace';
import * as ws from '@/api/workspace';
import type { ScopeKeyring } from '@/crypto/keyring';
import * as cache from '@/db/cache';
import { buildIndexEntry, type IndexedNote } from '@/lib/search';

/** How often a focused tab asks for changes. Hidden tabs back off hard. */
export const POLL_ACTIVE_MS = 8_000;
export const POLL_HIDDEN_MS = 60_000;
/**
 * How often to try anyway with no connection. The browser's `online` event covers losing an
 * interface, but not a server that was down and came back, so the only way to find that out
 * is to ask — rarely enough that a long outage is not a request per few seconds.
 */
export const POLL_OFFLINE_MS = 20_000;

export interface Snapshot {
  folders: ws.FolderNode[];
  notes: ws.NoteNode[];
  cursor: number;
}

/**
 * Reads whatever the last session left behind. It is ciphertext, so this is the point
 * where the master key turns a cold start into a usable tree without touching the network.
 */
export async function fromCache(vaultId: number, keyring: ScopeKeyring): Promise<Snapshot> {
  const [cached, cursor] = await Promise.all([cache.readTree(vaultId), cache.readCursor(vaultId)]);

  return {
    folders: await Promise.all(cached.folders.map((dto) => ws.openFolderDto(dto, keyring))),
    notes: await Promise.all(cached.notes.map((dto) => ws.openNoteDto(dto, keyring))),
    cursor,
  };
}

/**
 * Reads a note body: the server first, and what this device already holds when the server
 * cannot be reached.
 *
 * Without the fallback the tree paints from the cache with no network and then every note
 * in it refuses to open, which is a cache that answers the one question nobody asked. The
 * cached copy is also the newer one once a write has been queued — `queue` puts the sealed
 * body here as well — so coming back to a note edited offline shows what was typed rather
 * than the version the server still has.
 */
export async function readBody(note: ws.NoteNode, keyring: ScopeKeyring): Promise<ws.NoteBody> {
  try {
    return await ws.readNote(note.id, keyring);
  } catch (cause) {
    if (!(cause instanceof OfflineError)) throw cause;

    const cached = await cache.readBody(note.vaultId, note.id);
    if (!cached) throw cause;

    const dto = {
      vault_id: note.vaultId,
      client_id: note.clientId,
      key_scope_id: note.keyScopeId,
      key_scope_client_id: note.keyScopeClientId,
      key_version: note.keyVersion,
    };

    const body = await ws.openBody(dto, cached.content, cached.contentNonce, keyring);

    // A note this member cannot open reads the same offline as it does online. Anything else
    // that will not open is a stale ciphertext, and only the server can settle that.
    if (body === null) {
      if (note.locked) return { body: '', contentSeq: cached.contentSeq, locked: true };

      throw cause;
    }

    return { body, contentSeq: cached.contentSeq, locked: false };
  }
}

export interface PullResult extends Snapshot {
  /** True when the server told the client to forget everything it had cached. */
  resynced: boolean;
}

/**
 * Drains the change feed into the cache and returns the resulting tree.
 *
 * A full-resync signal is obeyed before anything else: it means this member's access
 * changed, so what they cached is no longer what they are entitled to.
 */
export async function pull(
  vaultId: number,
  keyring: ScopeKeyring,
  from: number,
): Promise<PullResult> {
  let cursor = from;
  let resynced = false;
  let guard = 0;

  for (;;) {
    const delta = await ws.fetchDelta(vaultId, cursor);

    if (delta.full_resync_required && !resynced) {
      await cache.dropVault(vaultId);
      cursor = 0;
      resynced = true;
      continue;
    }

    await cache.applyDelta(vaultId, delta.folders, delta.files, delta.purged);
    cursor = delta.cursor;
    await cache.writeCursor(vaultId, cursor);

    // A page always ends on a change-sequence boundary, so a feed that keeps claiming
    // more without moving the cursor is a bug, not a backlog.
    if (!delta.has_more || (guard += 1) > 100) break;
  }

  return { ...(await fromCache(vaultId, keyring)), resynced };
}

export interface Hydration {
  index: IndexedNote[];
  /** Notes whose body is in the index, over the notes the viewer can open. */
  covered: number;
  total: number;
}

/**
 * Fills the local index with note bodies, cache first and network only for what is
 * missing or stale. Until this finishes, search is answering from a partial index — which
 * is why the coverage is reported rather than hidden.
 */
export async function hydrate(
  vaultId: number,
  keyring: ScopeKeyring,
  notes: ws.NoteNode[],
  pathOf: (note: ws.NoteNode) => string,
): Promise<Hydration> {
  const readable = notes.filter((note) => !note.locked);
  const cached = new Map((await cache.readBodies(vaultId)).map((body) => [body.id, body]));

  const stale = readable.filter((note) => cached.get(note.id)?.contentSeq !== note.contentSeq);

  for (let i = 0; i < stale.length; i += ws.BULK_LIMIT) {
    const page = stale.slice(i, i + ws.BULK_LIMIT);
    const { files } = await ws.fetchBodies(vaultId, page.map((note) => note.id));

    const rows = files
      .filter((dto): dto is FileDto & { content: string; content_nonce: string } =>
        Boolean(dto.content && dto.content_nonce),
      )
      .map((dto) => ({
        vaultId,
        id: dto.id,
        content: dto.content,
        contentNonce: dto.content_nonce,
        contentSeq: dto.content_seq,
      }));

    await cache.writeBodies(rows);
    for (const row of rows) cached.set(row.id, row);
  }

  const index: IndexedNote[] = [];

  for (const note of readable) {
    const body = cached.get(note.id);
    if (!body) continue;

    const text = await ws.openBody(
      {
        vault_id: note.vaultId,
        client_id: note.clientId,
        key_scope_id: note.keyScopeId,
        key_scope_client_id: note.keyScopeClientId,
        key_version: note.keyVersion,
      },
      body.content,
      body.contentNonce,
      keyring,
    );

    if (text !== null) index.push(buildIndexEntry(note, text, pathOf(note)));
  }

  return { index, covered: index.length, total: readable.length };
}

/** Folder path of a note, the way the search results and the palette print it. */
export function pathBuilder(folders: FolderDto[] | ws.FolderNode[]): (note: ws.NoteNode) => string {
  const byId = new Map<number, ws.FolderNode>();

  for (const folder of folders as ws.FolderNode[]) byId.set(folder.id, folder);

  return (note) => {
    const parts: string[] = [];

    let current = note.folderId === null ? undefined : byId.get(note.folderId);
    let guard = 0;

    while (current && (guard += 1) < 64) {
      parts.unshift(current.name);
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }

    return parts.join('/').toUpperCase();
  };
}
