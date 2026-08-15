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
const VERSION = 1;

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

interface Schema extends DBSchema {
  folders: { key: [number, number]; value: Cached<FolderDto>; indexes: { vault: number } };
  notes: { key: [number, number]; value: Cached<FileDto>; indexes: { vault: number } };
  bodies: { key: [number, number]; value: CachedBody; indexes: { vault: number } };
  cursors: { key: number; value: VaultCursor };
}

let db: Promise<IDBPDatabase<Schema>> | null = null;

function open(): Promise<IDBPDatabase<Schema>> {
  db ??= openDB<Schema>(NAME, VERSION, {
    upgrade(database) {
      for (const store of ['folders', 'notes', 'bodies'] as const) {
        database.createObjectStore(store, { keyPath: ['vaultId', 'id'] }).createIndex('vault', 'vaultId');
      }

      database.createObjectStore('cursors', { keyPath: 'vaultId' });
    },
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
  const tx = database.transaction(['folders', 'notes', 'bodies', 'cursors'], 'readwrite');

  for (const store of ['folders', 'notes', 'bodies'] as const) {
    const keys = await tx.objectStore(store).index('vault').getAllKeys(vaultId);
    for (const key of keys) await tx.objectStore(store).delete(key);
  }

  await tx.objectStore('cursors').delete(vaultId);
  await tx.done;
}

/** Wipes the whole cache, on sign-out or when the session is refused. */
export async function dropAll(): Promise<void> {
  const database = await open();
  const tx = database.transaction(['folders', 'notes', 'bodies', 'cursors'], 'readwrite');

  await Promise.all([
    tx.objectStore('folders').clear(),
    tx.objectStore('notes').clear(),
    tx.objectStore('bodies').clear(),
    tx.objectStore('cursors').clear(),
  ]);

  await tx.done;
}

export type { CachedBody };
