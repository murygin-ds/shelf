import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import type { ServerFrame } from '@/api/realtime';
import { generateKey } from '@/crypto/aead';
import type { EntityRef } from '@/crypto/envelope';
import { generateIdentity, generateMasterKey } from '@/crypto/identity';

import { peerColour } from './colour';
import { createPresence, type PresenceUser } from './presence';
import { createRoom, type Room } from './room';

const REF: EntityRef = {
  vaultId: 1,
  entity: 'file',
  entityId: '8f14e45f-ceea-467a-9f6b-1d2c3b4a5e60',
  scopeClientId: 'ba5eba11-0000-4000-8000-000000000001',
  keyVersion: 2,
};

const FILE_ID = 88;

/** A room wired to a key, with the frames it sends captured. */
async function room(key: CryptoKey): Promise<{ room: Room; sent: Array<Record<string, unknown>> }> {
  const identity = await generateIdentity(await generateMasterKey());
  const sent: Array<Record<string, unknown>> = [];

  const created = createRoom({
    fileId: FILE_ID,
    ref: REF,
    scope: { keyScopeId: 3, keyVersion: 2 },
    key,
    identity: identity.identity,
    body: 'text',
    contentSeq: 1,
    canEdit: true,
    send: (frame) => sent.push(frame),
    authorKey: () => identity.publicBlob,
    onReady: () => {},
    onText: () => {},
    onNotice: () => {},
  });

  // A document, so the room will publish rather than sit waiting for one. It is seeded the
  // way the server has it seeded: a document frame carrying no snapshot is one that was
  // invalidated, and the room starts over rather than adopting it.
  await created.receive({ type: 'absent', file_id: FILE_ID, epoch: 1 });
  await settle();

  const seeded = sent.find((frame) => frame['type'] === 'seed');

  await created.receive({
    type: 'doc',
    file_id: FILE_ID,
    epoch: 1,
    snapshot_seq: 0,
    updates: [],
    snapshot: String(seeded?.['payload'] ?? ''),
    nonce: String(seeded?.['nonce'] ?? ''),
  });
  await settle();

  return { room: created, sent };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('presence', () => {
  it('seals a caret and opens it at the other end', async () => {
    const key = await generateKey();

    const alice = await room(key);
    const bob = await room(key);

    const doc = new Y.Doc();
    const presence = createPresence({
      doc,
      text: doc.getText('body'),
      room: alice.room,
      self: { userId: 7, name: 'Alice' },
      nameOf: () => 'Alice',
    });

    presence.publish();
    await settle();

    const frame = alice.sent.find((f) => f['type'] === 'awareness');
    expect(frame).toBeDefined();

    const opened = await bob.room.openAwareness({
      type: 'awareness',
      file_id: FILE_ID,
      payload: String(frame?.['payload']),
      nonce: String(frame?.['nonce']),
    });

    expect(opened).not.toBeNull();

    presence.destroy();
  });

  // The identity on a caret is the server's word. A tab that writes somebody else's name
  // into the payload must not appear as them.
  it('attributes a caret to the sender the relay named, not the one in the payload', async () => {
    const key = await generateKey();

    const alice = await room(key);
    const bob = await room(key);

    const impostorDoc = new Y.Doc();
    const impostor = createPresence({
      doc: impostorDoc,
      text: impostorDoc.getText('body'),
      room: alice.room,
      self: { userId: 5, name: 'Impostor' },
      nameOf: () => 'Impostor',
    });

    // Claiming to be user 7 inside the sealed blob.
    impostor.awareness.setLocalStateField('user', {
      id: 7,
      name: 'Alice',
      ...peerColour(7),
    } satisfies PresenceUser);

    await settle();

    const frame = alice.sent.filter((f) => f['type'] === 'awareness').at(-1);
    expect(frame).toBeDefined();

    const receiverDoc = new Y.Doc();
    const receiver = createPresence({
      doc: receiverDoc,
      text: receiverDoc.getText('body'),
      room: bob.room,
      self: { userId: 9, name: 'Bob' },
      nameOf: (userId) => (userId === 5 ? 'Impostor' : 'Someone else'),
    });

    // The relay says this came from user 5, whatever the payload claims.
    const delivered: ServerFrame = {
      type: 'awareness',
      file_id: FILE_ID,
      user_id: 5,
      payload: String(frame?.['payload']),
      nonce: String(frame?.['nonce']),
    };

    await receiver.accept(delivered);

    const others = [...receiver.awareness.getStates().entries()]
      .filter(([clientId]) => clientId !== receiverDoc.clientID)
      .map(([, state]) => (state as { user?: PresenceUser }).user);

    expect(others).toHaveLength(1);
    expect(others[0]?.id).toBe(5);
    expect(others[0]?.name).toBe('Impostor');

    impostor.destroy();
    receiver.destroy();
  });

  // Typing where somebody else's caret sits must not drag it along.
  //
  // The default association binds a caret to the character on its right, so an insert at
  // exactly that spot carries it forward — press Enter under it and it lands on the new
  // line, which reads as the other person having moved when they have not.
  it('leaves an arriving caret where its owner put it when somebody types there', async () => {
    const key = await generateKey();

    const sending = await room(key);
    const receiving = await room(key);

    // Both sides hold the same text, as two editors of one note do.
    const senderDoc = new Y.Doc();
    const senderText = senderDoc.getText('body');
    senderText.insert(0, 'abc');

    const receiverDoc = new Y.Doc();
    const receiverText = receiverDoc.getText('body');
    Y.applyUpdate(receiverDoc, Y.encodeStateAsUpdate(senderDoc));

    const sender = createPresence({
      doc: senderDoc,
      text: senderText,
      room: sending.room,
      self: { userId: 5, name: 'Ann' },
      nameOf: () => 'Ann',
    });

    // Ann's caret sits at the end of "abc", encoded the way the CodeMirror plugin does it.
    sender.awareness.setLocalStateField('cursor', {
      anchor: Y.createRelativePositionFromTypeIndex(senderText, 3),
      head: Y.createRelativePositionFromTypeIndex(senderText, 3),
    });

    await settle();

    const frame = sending.sent.filter((f) => f['type'] === 'awareness').at(-1);

    const receiver = createPresence({
      doc: receiverDoc,
      text: receiverText,
      room: receiving.room,
      self: { userId: 9, name: 'Bob' },
      nameOf: () => 'Ann',
    });

    await receiver.accept({
      type: 'awareness',
      file_id: FILE_ID,
      user_id: 5,
      payload: String(frame?.['payload']),
      nonce: String(frame?.['nonce']),
    });

    const stored = [...receiver.awareness.getStates().entries()]
      .filter(([clientId]) => clientId !== receiverDoc.clientID)
      .map(([, state]) => (state as { cursor?: { head: unknown } }).cursor)
      .find((cursor) => cursor !== undefined);

    expect(stored).toBeDefined();

    // Bob types at that exact spot, and then breaks the line there.
    receiverText.insert(3, 'XY');
    receiverText.insert(3, '\n');

    const resolved = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(stored?.head),
      receiverDoc,
    );

    // Still at the end of "abc", not carried onto the new line with Bob's text.
    expect(resolved?.index).toBe(3);
    expect(receiverText.toString().slice(0, resolved?.index)).toBe('abc');

    sender.destroy();
    receiver.destroy();
  });

  // A caret left behind by a closed tab would sit in the text forever.
  it('drops the carets of people who have left', async () => {
    const key = await generateKey();

    const alice = await room(key);
    const bob = await room(key);

    const senderDoc = new Y.Doc();
    const sender = createPresence({
      doc: senderDoc,
      text: senderDoc.getText('body'),
      room: alice.room,
      self: { userId: 5, name: 'Ann' },
      nameOf: () => 'Ann',
    });

    sender.publish();
    await settle();

    const frame = alice.sent.filter((f) => f['type'] === 'awareness').at(-1);

    const receiverDoc = new Y.Doc();
    const receiver = createPresence({
      doc: receiverDoc,
      text: receiverDoc.getText('body'),
      room: bob.room,
      self: { userId: 9, name: 'Bob' },
      nameOf: () => 'Ann',
    });

    await receiver.accept({
      type: 'awareness',
      file_id: FILE_ID,
      user_id: 5,
      payload: String(frame?.['payload']),
      nonce: String(frame?.['nonce']),
    });

    const before = receiver.awareness.getStates().size;
    expect(before).toBeGreaterThan(1);

    // The presence frame no longer lists user 5.
    receiver.retain([{ user_id: 9, login: 'bob', display_name: 'Bob', permission: 'edit' }]);

    expect(receiver.awareness.getStates().size).toBe(before - 1);

    sender.destroy();
    receiver.destroy();
  });
});
