import { type DBSchema, type IDBPDatabase, openDB } from 'idb';

import { decrypt, encrypt, exportKey, importKey, type Sealed } from '@/crypto/aead';
import { utf8 } from '@/crypto/bytes';

/**
 * Lets a reload skip the passphrase without letting a new tab skip it.
 *
 * The master key is wrapped with an AES key generated non-extractable, so the bytes that
 * open it never exist outside WebCrypto and cannot be lifted out of the profile on disk.
 * Permission to use that wrap is a marker in sessionStorage, which dies with the tab — so
 * the key is readable exactly as long as the tab that was already holding it in memory.
 *
 * A browser told to restore its tabs restores sessionStorage with them, which is the one
 * way this outlives a real tab. The record expires to bound that.
 */
const NAME = 'shelf-unlock';
const VERSION = 1;
const STORE = 'resumable';
const MARKER = 'shelf.unlock';

/** Slides forward on every resume, so an open tab keeps working and a forgotten one lapses. */
const TTL_MS = 12 * 60 * 60 * 1000;

const AAD_LABEL = 'shelf/tab-unlock/v1|';

interface Resumable {
  id: string;
  login: string;
  /** Non-extractable: structured clone carries it in here, exportKey never carries it out. */
  wrappingKey: CryptoKey;
  wrapped: Sealed;
  expiresAt: number;
}

interface Schema extends DBSchema {
  resumable: { key: string; value: Resumable };
}

export interface Resumed {
  login: string;
  masterKey: CryptoKey;
}

/** Whether this tab has something to resume, answered without touching IndexedDB. */
export function pending(): boolean {
  return marker() !== null;
}

export async function remember(login: string, masterKey: CryptoKey): Promise<void> {
  const wrappingKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);

  const wrapped = await encrypt(wrappingKey, await exportKey(masterKey), aad(login));
  const id = crypto.randomUUID();

  const stored = await withDb(async (db) => {
    await sweep(db);
    await db.put(STORE, { id, login, wrappingKey, wrapped, expiresAt: Date.now() + TTL_MS });

    return true;
  });

  // The marker goes last: without the record it would promise a resume that cannot happen,
  // and the reload would spend a round trip finding that out.
  if (stored) write(id);
}

export async function resume(): Promise<Resumed | null> {
  const id = marker();

  if (id === null) return null;

  return withDb(async (db) => {
    await sweep(db);

    const row = await db.get(STORE, id);

    if (!row) return null;

    const raw = await decrypt(row.wrappingKey, row.wrapped, aad(row.login));

    await db.put(STORE, { ...row, expiresAt: Date.now() + TTL_MS });

    return { login: row.login, masterKey: await importKey(raw) };
  });
}

export async function forget(): Promise<void> {
  const id = marker();

  write(null);

  if (id === null) return;

  await withDb(async (db) => {
    await db.delete(STORE, id);

    return true;
  });
}

function aad(login: string): Uint8Array {
  return utf8(AAD_LABEL + login);
}

function marker(): string | null {
  try {
    return sessionStorage.getItem(MARKER);
  } catch {
    // Storage can be blocked outright, in which case there is simply nothing to resume.
    return null;
  }
}

function write(id: string | null): void {
  try {
    if (id === null) sessionStorage.removeItem(MARKER);
    else sessionStorage.setItem(MARKER, id);
  } catch {
    // Same as above: the passphrase prompt is the fallback and it always works.
  }
}

async function withDb<T>(run: (db: IDBPDatabase<Schema>) => Promise<T>): Promise<T | null> {
  let db: IDBPDatabase<Schema> | null = null;

  try {
    db = await openDB<Schema>(NAME, VERSION, {
      upgrade(database) {
        database.createObjectStore(STORE, { keyPath: 'id' });
      },
    });

    return await run(db);
  } catch {
    // A private window, a wrap that no longer opens, a browser refusing storage: every one
    // of them means this tab has to ask for the passphrase, not that the app is broken.
    return null;
  } finally {
    // Held open, this connection would block the next version upgrade from another tab.
    db?.close();
  }
}

/** Records outlive their tabs — a crash leaves one behind that no marker points at. */
async function sweep(db: IDBPDatabase<Schema>): Promise<void> {
  const now = Date.now();
  const tx = db.transaction(STORE, 'readwrite');

  for (const row of await tx.store.getAll()) {
    if (row.expiresAt <= now) await tx.store.delete(row.id);
  }

  await tx.done;
}
