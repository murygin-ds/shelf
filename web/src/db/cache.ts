import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import type { FileDto, FolderDto } from '@/api/workspace';

/**
 * The local cache stores exactly what the server stores: ciphertext and the metadata
 * around it. Nothing here is readable without the master key, so a stolen browser profile
 * is no worse than a stolen database dump.
 *
 * The decrypted index that search runs against is built from this on unlock and lives in
 * memory only, which is what makes the lock state mean something.
 */
const NAME = 'shelf';
const VERSION = 2;

interface Cached<T> {
  vaultId: number;
  id: number;
  value: T;
}

interface CachedBody {
  vaultId: number;
  id: number;
  content: string;
  contentNonce: string;
  contentSeq: number;
}

interface VaultCursor {
  vaultId: number;
  cursor: number;
}

/**
 * A note body that was written while the network was gone.
 *
 * It holds ciphertext, like everything else here: the body is sealed before it is queued,
 * so a stolen browser profile is no more revealing with a full outbox than with an empty
 * one. One entry per note — a body write replaces the whole body, so the newest attempt is
 * the only one worth keeping.
 */
interface Queued {
  id: number;
  vaultId: number;
  contentSeq: number;
  payload: {
    content: string;
    content_nonce: string;
    key_scope_id: number;
    key_version: number;
    signature?: string;
  };
  queuedAt: number;
}

interface Schema extends DBSchema {
  folders: { key: [number, number]; value: Cached<FolderDto>; indexes: { vault: number } };
  notes: { key: [number, number]; value: Cached<FileDto>; indexes: { vault: number } };
  bodies: { key: [number, number]; value: CachedBody; indexes: { vault: number } };
  cursors: { key: number; value: VaultCursor };
  outbox: { key: number; value: Queued; indexes: { vault: number } };
}

let db: Promise<IDBPDatabase<Schema>> | null = null;

/**
 * How long to wait for the browser to hand over the database.
 *
 * An open request that is blocked by another connection never settles: it neither resolves
 * nor rejects. Awaiting it forever would leave the workspace on a status line that reads
 * "synced" while nothing at all is happening, which is worse than having no cache — so
 * after this the cache is treated as absent and the network answers instead.
 */
const OPEN_TIMEOUT_MS = 3000;

class CacheUnavailable extends Error {
  constructor(message = 'the local cache is not available in this browser') {
    super(message);
    this.name = 'CacheUnavailable';
  }
}

function open(): Promise<IDBPDatabase<Schema>> {
  db ??= Promise.race([
    openDB<Schema>(NAME, VERSION, {
      blocked() {
        // Another tab holds the old schema open. The upgrade cannot start until it closes,
        // and waiting silently would look like the app had simply stopped.
        throw new CacheUnavailable('another tab is holding an older version of this app open');
      },
      blocking(_current, _blocked, event) {
        // This tab is the one in the way. Closing frees the newer one rather than leaving
        // both stuck; this tab will reopen on its next read.
        (event.target as IDBPDatabase<Schema>).close();
        db = null;
      },
      upgrade(database, from) {
        if (from < 1) {
          for (const store of ['folders', 'notes', 'bodies'] as const) {
            database
              .createObjectStore(store, { keyPath: ['vaultId', 'id'] })
              .createIndex('vault', 'vaultId');
          }

          database.createObjectStore('cursors', { keyPath: 'vaultId' });
        }

        if (from < 2) {
          database.createObjectStore('outbox', { keyPath: 'id' }).createIndex('vault', 'vaultId');
        }
      },
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new CacheUnavailable()), OPEN_TIMEOUT_MS);
    }),
  ]).catch((cause: unknown) => {
    // Retry on the next call rather than remembering the failure forever: a blocked open
    // usually clears as soon as the other tab goes away.
    db = null;
    throw cause;
  });

  return db;
}

export async function readCursor(vaultId: number): Promise<number> {
  return (await (await open()).get('cursors', vaultId))?.cursor ?? 0;
}

export async function writeCursor(vaultId: number, cursor: number): Promise<void> {
  await (await open()).put('cursors', { vaultId, cursor });
}

export async function readTree(
  vaultId: number,
): Promise<{ folders: FolderDto[]; notes: FileDto[] }> {
  const database = await open();

  const [folders, notes] = await Promise.all([
    database.getAllFromIndex('folders', 'vault', vaultId),
    database.getAllFromIndex('notes', 'vault', vaultId),
  ]);

  return { folders: folders.map((row) => row.value), notes: notes.map((row) => row.value) };
}

export async function applyDelta(
  vaultId: number,
  folders: FolderDto[],
  notes: FileDto[],
  purged: { folders: number[]; files: number[] },
): Promise<void> {
  const database = await open();
  const tx = database.transaction(['folders', 'notes', 'bodies'], 'readwrite');

  for (const folder of folders) {
    await tx.objectStore('folders').put({ vaultId, id: folder.id, value: folder });
  }

  for (const note of notes) {
    await tx.objectStore('notes').put({ vaultId, id: note.id, value: note });
  }

  // A purged node leaves nothing behind on the server, so its cached body has to go too.
  for (const id of purged.folders) await tx.objectStore('folders').delete([vaultId, id]);

  for (const id of purged.files) {
    await tx.objectStore('notes').delete([vaultId, id]);
    await tx.objectStore('bodies').delete([vaultId, id]);
  }

  await tx.done;
}

export async function readBody(vaultId: number, id: number): Promise<CachedBody | undefined> {
  return (await open()).get('bodies', [vaultId, id]);
}

export async function writeBodies(bodies: CachedBody[]): Promise<void> {
  const database = await open();
  const tx = database.transaction('bodies', 'readwrite');

  for (const body of bodies) await tx.store.put(body);

  await tx.done;
}

export async function readBodies(vaultId: number): Promise<CachedBody[]> {
  return (await open()).getAllFromIndex('bodies', 'vault', vaultId);
}

/**
 * Drops everything cached for one vault. This is what a full-resync signal triggers: the
 * server cannot know what a client already holds, so the only way to make it forget
 * plaintext it may no longer be entitled to is to have it start over.
 */
export async function dropVault(vaultId: number): Promise<void> {
  const database = await open();
  // The outbox goes with the rest: a full resync means this device's view was wrong, and
  // replaying a write sealed against that view would put the wrong body back.
  const tx = database.transaction(['folders', 'notes', 'bodies', 'cursors', 'outbox'], 'readwrite');

  for (const store of ['folders', 'notes', 'bodies', 'outbox'] as const) {
    const keys = await tx.objectStore(store).index('vault').getAllKeys(vaultId);
    for (const key of keys) await tx.objectStore(store).delete(key);
  }

  await tx.objectStore('cursors').delete(vaultId);
  await tx.done;
}

/** Wipes the whole cache, on sign-out or when the session is refused. */
export async function dropAll(): Promise<void> {
  const database = await open();
  // Signing out leaves nothing behind, the outbox included: it holds ciphertext, but it is
  // ciphertext this account wrote and the next person at this browser has no business
  // finding it.
  const tx = database.transaction(['folders', 'notes', 'bodies', 'cursors', 'outbox'], 'readwrite');

  await Promise.all([
    tx.objectStore('folders').clear(),
    tx.objectStore('notes').clear(),
    tx.objectStore('bodies').clear(),
    tx.objectStore('cursors').clear(),
    tx.objectStore('outbox').clear(),
  ]);

  await tx.done;
}

export type { CachedBody };

/** Queues a body written with no network, replacing any earlier attempt at the same note. */
export async function enqueue(write: Queued): Promise<void> {
  await (await open()).put('outbox', write);
}

export async function outbox(vaultId: number): Promise<Queued[]> {
  return (await open()).getAllFromIndex('outbox', 'vault', vaultId);
}

export async function dequeue(id: number): Promise<void> {
  await (await open()).delete('outbox', id);
}

export async function outboxSize(vaultId: number): Promise<number> {
  return (await outbox(vaultId)).length;
}

export type { Queued };
