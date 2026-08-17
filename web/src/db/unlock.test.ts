import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateKey } from '@/crypto/aead';

import { forget, pending, remember, resume } from './unlock';

/**
 * What a reload is allowed to skip and what it is not. The record is the only thing in the
 * app that survives a reload with the master key in it, so its boundaries — this tab, this
 * account, this window of time — are the whole of what makes it safe.
 */

interface Row {
  id: string;
  login: string;
  wrappingKey: CryptoKey;
  expiresAt: number;
}

const db = {
  rows: new Map<string, Row>(),
  closed: 0,

  put(_store: string, value: Row) {
    db.rows.set(value.id, value);

    return Promise.resolve();
  },
  get(_store: string, id: string) {
    return Promise.resolve(db.rows.get(id));
  },
  delete(_store: string, id: string) {
    db.rows.delete(id);

    return Promise.resolve();
  },
  transaction() {
    return {
      store: {
        getAll: () => Promise.resolve([...db.rows.values()]),
        delete: (id: string) => {
          db.rows.delete(id);

          return Promise.resolve();
        },
      },
      done: Promise.resolve(),
    };
  },
  close() {
    db.closed += 1;
  },
};

const state = vi.hoisted(() => ({ unavailable: false }));

vi.mock('idb', () => ({
  openDB: () => {
    if (state.unavailable) throw new Error('storage is blocked');

    return Promise.resolve(db);
  },
}));

let marker: Record<string, string> = {};

beforeEach(() => {
  db.rows.clear();
  db.closed = 0;
  state.unavailable = false;
  marker = {};

  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => marker[key] ?? null,
    setItem: (key: string, value: string) => {
      marker[key] = value;
    },
    removeItem: (key: string) => {
      delete marker[key];
    },
  });
});

const raw = async (key: CryptoKey) =>
  Buffer.from(await crypto.subtle.exportKey('raw', key)).toString('hex');

/** The one record these tests write. */
function only(): Row {
  const [row] = [...db.rows.values()];

  if (!row) throw new Error('nothing was stored');

  return row;
}

describe('tab unlock record', () => {
  it('hands the same master key back to a reload of the same tab', async () => {
    const masterKey = await generateKey();
    await remember('ada@example.org', masterKey);

    expect(pending()).toBe(true);

    const resumed = await resume();

    expect(resumed?.login).toBe('ada@example.org');
    expect(await raw(resumed!.masterKey)).toBe(await raw(masterKey));
  });

  it('is useless to a tab that never wrote it', async () => {
    await remember('ada@example.org', await generateKey());

    // A new tab starts with the record still in the database and no marker pointing at it.
    marker = {};

    expect(pending()).toBe(false);
    await expect(resume()).resolves.toBeNull();
  });

  it('wraps the key with something no code can read out', async () => {
    await remember('ada@example.org', await generateKey());

    const { wrappingKey } = only();

    expect(wrappingKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', wrappingKey)).rejects.toThrow();
  });

  it('forgets both halves, so neither a marker nor a record is left behind', async () => {
    await remember('ada@example.org', await generateKey());
    await forget();

    expect(pending()).toBe(false);
    expect(db.rows.size).toBe(0);
    await expect(resume()).resolves.toBeNull();
  });

  it('drops a record that outlived its window instead of opening it', async () => {
    await remember('ada@example.org', await generateKey());

    for (const row of db.rows.values()) row.expiresAt = Date.now() - 1;

    await expect(resume()).resolves.toBeNull();
    expect(db.rows.size).toBe(0);
  });

  it('slides the window forward on every resume', async () => {
    vi.useFakeTimers();

    try {
      await remember('ada@example.org', await generateKey());

      const written = only().expiresAt;

      vi.advanceTimersByTime(60_000);
      await resume();

      expect(only().expiresAt).toBe(written + 60_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('will not open a record moved to another account', async () => {
    await remember('ada@example.org', await generateKey());

    // The login is bound into the AAD, so editing it in the row breaks the wrap rather
    // than handing the keys of one account to another.
    for (const row of db.rows.values()) row.login = 'eve@example.org';

    await expect(resume()).resolves.toBeNull();
  });

  it('promises nothing when the browser refuses storage', async () => {
    state.unavailable = true;

    await remember('ada@example.org', await generateKey());

    expect(pending()).toBe(false);
    await expect(resume()).resolves.toBeNull();
  });

  it('closes every connection it opens, the failing reads included', async () => {
    await remember('ada@example.org', await generateKey());
    await resume();

    // A wrap that throws inside the transaction must not leak the connection either: one
    // left open blocks the next version upgrade from another tab.
    for (const row of db.rows.values()) row.login = 'eve@example.org';
    await resume();

    await forget();

    expect(db.closed).toBe(4);
  });
});
