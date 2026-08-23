import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { ServerFrame } from '@/api/realtime';
import { generateKey } from '@/crypto/aead';
import { b64ToBytes, bytesToB64 } from '@/crypto/bytes';
import type { EntityRef } from '@/crypto/envelope';
import { generateIdentity, generateMasterKey, type Identity } from '@/crypto/identity';

import { createRoom, FLUSH_MS, type Room, type RoomNotice } from './room';

const REF: EntityRef = {
  vaultId: 1,
  entity: 'file',
  entityId: '8f14e45f-ceea-467a-9f6b-1d2c3b4a5e60',
  scopeClientId: 'ba5eba11-0000-4000-8000-000000000001',
  keyVersion: 2,
};

const SCOPE = { keyScopeId: 3, keyVersion: 2 };
const FILE_ID = 88;

/**
 * A server that behaves: it keeps one document per note, hands out sequences and relays
 * updates to everybody but the sender. It checks nothing — the point of the tests below is
 * that the clients do.
 */
class Relay {
  epoch = 0;
  lastSeq = 0;
  snapshot: { payload: string; nonce: string } | null = null;
  log: Array<{ seq: number; payload: string; nonce: string; author_id: number; signature?: string }> = [];

  private readonly rooms = new Map<Room, number>();

  attach(room: Room, userId: number): void {
    this.rooms.set(room, userId);
  }

  /** Takes one frame from a client and answers the way the Go relay would. */
  async take(from: Room, frame: Record<string, unknown>): Promise<void> {
    const userId = this.rooms.get(from) ?? 0;

    switch (frame['type']) {
      case 'open':
        // A document with no snapshot describes nothing, so it is answered the way an
        // absent one is: whoever may write starts it again, at the epoch named here.
        await from.receive(
          this.snapshot === null
            ? { type: 'absent', file_id: FILE_ID, epoch: this.epoch === 0 ? 1 : this.epoch }
            : this.document(),
        );
        break;

      case 'seed':
        // A row that holds no snapshot is this seed's to fill, whether it was never there
        // or was emptied by a body written around the document. The epoch it already has
        // is kept, so an update still in flight against what was replaced is refused.
        if (this.snapshot === null) {
          this.epoch = Number(frame['epoch'] ?? 1);
          this.snapshot = { payload: String(frame['payload']), nonce: String(frame['nonce']) };
        }

        await from.receive(this.document());
        break;

      case 'update': {
        this.lastSeq += 1;

        const stored = {
          seq: this.lastSeq,
          payload: String(frame['payload']),
          nonce: String(frame['nonce']),
          author_id: userId,
          ...(frame['signature'] === undefined ? {} : { signature: String(frame['signature']) }),
        };

        this.log.push(stored);

        await from.receive({ type: 'ack', file_id: FILE_ID, epoch: this.epoch, seq: stored.seq });

        for (const [room] of this.rooms) {
          if (room === from) continue;

          await room.receive({
            type: 'update',
            file_id: FILE_ID,
            epoch: this.epoch,
            seq: stored.seq,
            payload: stored.payload,
            nonce: stored.nonce,
            user_id: stored.author_id,
            ...(stored.signature === undefined ? {} : { signature: stored.signature }),
          });
        }

        break;
      }

      default:
        break;
    }
  }

  document(): ServerFrame {
    return {
      type: 'doc',
      file_id: FILE_ID,
      epoch: this.epoch,
      snapshot_seq: 0,
      last_seq: this.lastSeq,
      ...(this.snapshot ? { snapshot: this.snapshot.payload, nonce: this.snapshot.nonce } : {}),
      updates: this.log.map((stored) => ({
        seq: stored.seq,
        payload: stored.payload,
        nonce: stored.nonce,
        author_id: stored.author_id,
        ...(stored.signature === undefined ? {} : { signature: stored.signature }),
      })),
    };
  }
}

interface Client {
  room: Room;
  notices: RoomNotice[];
  text(): string;
  edit(fn: (text: Y.Text) => void): void;
}

async function client(
  relay: Relay,
  identity: Identity,
  publicBlob: Uint8Array,
  userId: number,
  key: CryptoKey,
  keys: Map<number, Uint8Array>,
  body = '',
): Promise<Client> {
  keys.set(userId, publicBlob);

  const notices: RoomNotice[] = [];
  let doc: Y.Doc | null = null;
  let ytext: Y.Text | null = null;
  let latest = '';

  const room = createRoom({
    fileId: FILE_ID,
    ref: REF,
    scope: SCOPE,
    key,
    identity,
    body,
    contentSeq: 1,
    canEdit: true,
    send: (frame) => void relay.take(room, frame),
    authorKey: (id) => keys.get(id) ?? null,
    onReady: (readyDoc, readyText) => {
      doc = readyDoc;
      ytext = readyText;
    },
    onText: (text) => {
      latest = text;
    },
    onNotice: (notice) => notices.push(notice),
  });

  relay.attach(room, userId);
  room.join();

  // The join above is answered synchronously by the relay, but the promises inside it are
  // not: let them settle before the caller starts typing.
  await settle();

  return {
    room,
    notices,
    text: () => latest,
    edit: (fn) => {
      if (!ytext || !doc) throw new Error('the document is not ready');

      fn(ytext);
    },
  };
}

/**
 * Lets the room's awaits run. Every step of the handshake goes through WebCrypto, which
 * resolves on its own turns of the loop rather than on the microtask queue.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushed(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, FLUSH_MS + 20));
  await settle();
}

describe('editing room', () => {
  it('starts a document from the body when nobody has', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, author.identity, author.publicBlob, 7, key, keys, 'hello');

    expect(alice.room.ready()).toBe(true);
    expect(alice.text()).toBe('hello');
  });

  // The whole point of the exercise: two people typing at once keep both edits.
  it('merges concurrent edits without losing either', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();

    const first = await generateIdentity(await generateMasterKey());
    const second = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, first.identity, first.publicBlob, 7, key, keys, 'shared');
    const bob = await client(relay, second.identity, second.publicBlob, 9, key, keys);

    expect(bob.text()).toBe('shared');

    // Both type into the same line before either has heard from the other.
    alice.edit((text) => text.insert(0, 'A'));
    bob.edit((text) => text.insert(6, 'B'));

    await flushed();
    await flushed();

    expect(alice.text()).toBe(bob.text());
    expect(alice.text()).toContain('A');
    expect(alice.text()).toContain('B');
    expect(alice.text()).toContain('shared');
  });

  // The loser of the seeding race adopts the winner's document. Merging two independently
  // seeded copies would write the text twice, which is the bug this exists to prevent.
  it('adopts the document that got there first', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();

    const first = await generateIdentity(await generateMasterKey());
    const second = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, first.identity, first.publicBlob, 7, key, keys, 'once');
    const bob = await client(relay, second.identity, second.publicBlob, 9, key, keys, 'once');

    expect(alice.text()).toBe('once');
    expect(bob.text()).toBe('once');
  });

  // Refusing a reader's frames on the socket is the server behaving. This is what holds
  // when it does not: an update nobody can attribute is never merged.
  it('drops an update whose signature does not check out', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();

    const first = await generateIdentity(await generateMasterKey());
    const impostor = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, first.identity, first.publicBlob, 7, key, keys, 'safe');

    // A forged update: sealed correctly, signed by somebody who is not who it claims to be.
    const forged = new Y.Doc();
    forged.getText('body').insert(0, 'INJECTED');

    const { encryptUpdate } = await import('@/crypto/envelope');
    const { signUpdate } = await import('@/crypto/signature');

    const sealed = await encryptUpdate(key, Y.encodeStateAsUpdate(forged), REF, 1);
    const signature = await signUpdate(impostor.identity, REF, 1, sealed);

    // Attributed to Alice, so the room looks up her key and the signature fails against it.
    await alice.room.receive({
      type: 'update',
      file_id: FILE_ID,
      epoch: 1,
      seq: 99,
      payload: bytesToB64(sealed.ciphertext),
      nonce: bytesToB64(sealed.nonce),
      user_id: 7,
      signature: bytesToB64(signature),
    });

    expect(alice.text()).toBe('safe');
    expect(alice.notices).toContainEqual({ kind: 'unverified', userId: 7 });
  });

  it('drops an unsigned update rather than trusting it', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, author.identity, author.publicBlob, 7, key, keys, 'safe');

    const forged = new Y.Doc();
    forged.getText('body').insert(0, 'INJECTED');

    const { encryptUpdate } = await import('@/crypto/envelope');
    const sealed = await encryptUpdate(key, Y.encodeStateAsUpdate(forged), REF, 1);

    await alice.room.receive({
      type: 'update',
      file_id: FILE_ID,
      epoch: 1,
      seq: 99,
      payload: bytesToB64(sealed.ciphertext),
      nonce: bytesToB64(sealed.nonce),
      user_id: 7,
    });

    expect(alice.text()).toBe('safe');
  });

  // A snapshot is what the committer writes back with the body. It has to be openable by
  // anyone who holds the key, or the next session cannot restore the document.
  it('produces a snapshot the next session can restore', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, author.identity, author.publicBlob, 7, key, keys, 'draft');

    alice.edit((text) => text.insert(5, ' notes'));
    await flushed();

    const snapshot = await alice.room.snapshot();
    expect(snapshot).not.toBeNull();

    const { decryptUpdate } = await import('@/crypto/envelope');
    const state = await decryptUpdate(key, snapshot!.sealed, REF, snapshot!.epoch);

    const restored = new Y.Doc();
    Y.applyUpdate(restored, state as Uint8Array);

    expect(restored.getText('body').toString()).toBe('draft notes');
  });

  // A document replaced under the room cannot take the edits made against the old one, so
  // the room drops what it holds and asks for the replacement. Local edits that had not
  // reached the server go with it — which is why the reader is told, rather than left to
  // wonder where their last sentence went.
  it('starts over when the server says the document was replaced', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, author.identity, author.publicBlob, 7, key, keys, 'text');
    const before = alice.room.epoch();

    // The server replaces the document, the way a body written around it does: the row
    // stays so the epoch can go on rising, and it holds nothing.
    relay.epoch = 2;
    relay.snapshot = null;
    relay.log = [];

    await alice.room.receive({ type: 'reseed', file_id: FILE_ID });
    await settle();

    expect(alice.notices).toContainEqual({ kind: 'reseed' });
    expect(alice.room.epoch()).toBe(2);
    expect(alice.room.epoch()).not.toBe(before);
    expect(alice.room.ready()).toBe(true);
    expect(alice.text()).toBe('text');
  });

  // The row an invalidation leaves behind is not a document: it carries no snapshot and no
  // log. A room that adopted it would show an empty note and hand the committer that
  // emptiness to write back over the body the write had just put there.
  it('starts a document over rather than adopting an invalidated one', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    await client(relay, author.identity, author.publicBlob, 7, key, keys, 'draft');

    // The connector appends to the note, which invalidates the document behind it.
    relay.epoch = 2;
    relay.snapshot = null;
    relay.log = [];

    const appended = 'draft\n\nappended by the connector';

    // Somebody opens the note afterwards, holding the body the connector wrote.
    const bob = await client(relay, author.identity, author.publicBlob, 9, key, keys, appended);

    expect(bob.room.ready()).toBe(true);
    expect(bob.text()).toBe(appended);
    expect(bob.room.epoch()).toBe(2);
  });

  // A snapshot that will not open is not an empty document. Standing an empty one up in its
  // place would show an empty note and let the committer write that back over the body.
  it('refuses a document whose snapshot will not open', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, author.identity, author.publicBlob, 7, key, keys, 'text');

    // Sealed under something this client does not hold — a stale key, a snapshot written
    // against another epoch.
    await alice.room.receive({
      type: 'doc',
      file_id: FILE_ID,
      epoch: 3,
      snapshot_seq: 0,
      updates: [],
      snapshot: bytesToB64(Uint8Array.from({ length: 48 }, (_, i) => i)),
      nonce: bytesToB64(Uint8Array.from({ length: 12 }, (_, i) => i)),
    });
    await settle();

    expect(alice.notices.some((notice) => notice.kind === 'error')).toBe(true);
    expect(alice.text()).toBe('text');
    expect(alice.room.epoch()).toBe(1);
  });

  it('ignores frames about another note', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, author.identity, author.publicBlob, 7, key, keys, 'mine');

    await alice.room.receive({ type: 'reseed', file_id: FILE_ID + 1 });

    expect(alice.notices).toEqual([]);
    expect(alice.room.ready()).toBe(true);
  });

  it('seals a caret position so only the key holders can read it', async () => {
    const relay = new Relay();
    const key = await generateKey();
    const keys = new Map<number, Uint8Array>();
    const author = await generateIdentity(await generateMasterKey());

    const alice = await client(relay, author.identity, author.publicBlob, 7, key, keys, 'text');

    const sent: Array<Record<string, unknown>> = [];
    const spy = createRoom({
      fileId: FILE_ID,
      ref: REF,
      scope: SCOPE,
      key,
      identity: author.identity,
      body: '',
      contentSeq: 1,
      canEdit: true,
      send: (frame) => sent.push(frame),
      authorKey: () => author.publicBlob,
      onReady: () => {},
      onText: () => {},
      onNotice: () => {},
    });

    await spy.receive(relay.document());
    await spy.publishAwareness(Uint8Array.of(1, 2, 3));

    const frame = sent.find((f) => f['type'] === 'awareness');
    expect(frame).toBeDefined();

    const opened = await alice.room.openAwareness({
      type: 'awareness',
      file_id: FILE_ID,
      payload: String(frame!['payload']),
      nonce: String(frame!['nonce']),
    });

    expect(opened).toEqual(Uint8Array.of(1, 2, 3));

    // The sealed bytes are not the plaintext, which is the property that matters.
    expect(b64ToBytes(String(frame!['payload']))).not.toEqual(Uint8Array.of(1, 2, 3));
  });
});
