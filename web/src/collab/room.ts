/**
 * One note being edited by several people at once.
 *
 * The merge happens here, not on the server: it holds ciphertext and no key, so it can
 * neither transform an operation nor compare two versions. What it does is relay sealed
 * updates and refuse the ones from somebody who may not write. Everything below assumes
 * the server is doing that honestly, and nothing below depends on it — every update is
 * signed, and one that does not verify is dropped rather than merged.
 *
 * The document is the truth while a session is live; `files.content` is a projection one
 * client — the committer, named by the server — writes back periodically so search,
 * revisions, public links and offline reading keep working.
 */

import * as Y from 'yjs';

import {
  awarenessFrame,
  closeFrame,
  openFrame,
  openSealed,
  openSignature,
  seedFrame,
  type SealedWire,
  type ServerFrame,
  updateFrame,
  type WireUpdate,
} from '@/api/realtime';
import { decryptPresence, decryptUpdate, encryptPresence, encryptUpdate, type EntityRef, isLocked } from '@/crypto/envelope';
import type { Identity } from '@/crypto/identity';
import { checkUpdate, signUpdate } from '@/crypto/signature';

/**
 * How long local edits are gathered before one frame goes out.
 *
 * Below what a collaborator notices as lag, and it turns a burst of keystrokes into a
 * tenth of the frames, rows and signatures — an update carries 64 bytes of signature for
 * a few bytes of text, so batching is most of what keeps the log small.
 */
export const FLUSH_MS = 250;

/** Send at once past this, so a paste does not sit in the buffer. */
const FLUSH_BYTES = 8 * 1024;

/** Origin tag on transactions that came from the wire, so they are not echoed back. */
export const REMOTE = Symbol('remote');

export interface RoomScope {
  keyScopeId: number;
  keyVersion: number;
}

export interface RoomDeps {
  fileId: number;
  ref: EntityRef;
  scope: RoomScope;
  key: CryptoKey;
  identity: Identity;
  /** The body as this client last read it, used to seed a document nobody has started. */
  body: string;
  /** The version that body came from. A seed built from a stale one is refused. */
  contentSeq: number;
  /** Whether this client may write at all. A reader joins to watch. */
  canEdit: boolean;
  send(frame: Record<string, unknown>): void;
  /** The author's public key, for checking a signature before the update is merged. */
  authorKey(userId: number): Uint8Array | null;
  /** The document is ready to edit. */
  onReady(doc: Y.Doc, text: Y.Text): void;
  /** The text changed, whoever changed it. Feeds the title, the index and the wikilinks. */
  onText(text: string): void;
  /** Something the reader has to know about: a rejected update, a lost document. */
  onNotice(notice: RoomNotice): void;
}

export type RoomNotice =
  | { kind: 'unverified'; userId: number }
  | { kind: 'reseed' }
  | { kind: 'error'; code: string; message: string };

export interface Room {
  /** Opens the note on the socket. Called again after a reconnect. */
  join(): void;
  /** Takes what the socket delivered for this note. Frames for others are ignored. */
  receive(frame: ServerFrame): Promise<void>;
  /** Seals and sends a caret position. */
  publishAwareness(state: Uint8Array): Promise<void>;
  /** Opens somebody else's caret position. Null when it cannot be read. */
  openAwareness(frame: ServerFrame): Promise<Uint8Array | null>;
  /** The document state and the sequence it covers, for the committer's write-back. */
  snapshot(): Promise<{ sealed: SealedWire; epoch: number; uptoSeq: number } | null>;
  /** The text as it stands. */
  text(): string;
  /** Whether the document is ready to be edited. */
  ready(): boolean;
  epoch(): number;
  /** Leaves the room and stops everything. */
  close(): void;
}

export function createRoom(deps: RoomDeps): Room {
  let doc: Y.Doc | null = null;
  let ytext: Y.Text | null = null;
  let currentEpoch = 0;
  let lastSeq = 0;
  let seeding = false;
  let closed = false;

  let buffer: Uint8Array[] = [];
  let bufferBytes = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  function build(): { doc: Y.Doc; text: Y.Text } {
    const created = new Y.Doc();
    const text = created.getText('body');

    created.on('update', (update: Uint8Array, origin: unknown) => {
      // What arrived from the wire is already everybody's; sending it back would loop.
      if (origin === REMOTE) return;

      buffer.push(update);
      bufferBytes += update.length;

      if (bufferBytes >= FLUSH_BYTES) {
        void flush();
        return;
      }

      flushTimer ??= setTimeout(() => void flush(), FLUSH_MS);
    });

    text.observe(() => deps.onText(text.toString()));

    return { doc: created, text };
  }

  async function flush(): Promise<void> {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    if (closed || buffer.length === 0 || currentEpoch === 0) return;

    const merged = Y.mergeUpdates(buffer);
    buffer = [];
    bufferBytes = 0;

    const sealed = await encryptUpdate(deps.key, merged, deps.ref, currentEpoch);
    const signature = await signUpdate(deps.identity, deps.ref, currentEpoch, sealed);

    deps.send(updateFrame(deps.fileId, currentEpoch, sealed, deps.scope, signature));
  }

  /**
   * Starts a document from the body this client holds.
   *
   * Exactly one client wins this: the server takes the first insert and hands everybody
   * else what it stored. The loser throws its own document away rather than merging —
   * two independently seeded copies name the same characters differently, and merging
   * them writes the text twice.
   */
  async function seed(): Promise<void> {
    if (!deps.canEdit || seeding) return;

    seeding = true;

    const candidate = new Y.Doc();
    candidate.getText('body').insert(0, deps.body);

    const state = Y.encodeStateAsUpdate(candidate);
    candidate.destroy();

    // Sealed under epoch 1 because that is what a fresh document is; if somebody else got
    // there first the server ignores this payload entirely and answers with theirs.
    const sealed = await encryptUpdate(deps.key, state, deps.ref, 1);
    const signature = await signUpdate(deps.identity, deps.ref, 1, sealed);

    deps.send(seedFrame(deps.fileId, deps.contentSeq, sealed, deps.scope, signature));
  }

  /** Replaces whatever this client held with the document the server has. */
  async function adopt(frame: ServerFrame): Promise<void> {
    const epoch = frame.epoch ?? 0;
    if (epoch === 0) return;

    doc?.destroy();

    const built = build();
    doc = built.doc;
    ytext = built.text;
    currentEpoch = epoch;
    lastSeq = frame.snapshot_seq ?? 0;
    seeding = false;
    buffer = [];
    bufferBytes = 0;

    const snapshot = openSealed(frame.snapshot, frame.nonce);

    if (snapshot) {
      const state = await decryptUpdate(deps.key, snapshot, deps.ref, epoch);

      if (!isLocked(state)) Y.applyUpdate(doc, state, REMOTE);
    }

    for (const stored of frame.updates ?? []) {
      await apply(stored, epoch);
    }

    deps.onReady(doc, ytext);
    deps.onText(ytext.toString());
  }

  /** Verifies one update and merges it. Anything that does not verify is not applied. */
  async function apply(stored: WireUpdate, epoch: number): Promise<void> {
    if (!doc) return;

    const sealed = openSealed(stored.payload, stored.nonce);
    if (!sealed) return;

    const authorId = stored.author_id ?? 0;
    const verdict = await checkUpdate(
      deps.authorKey(authorId),
      openSignature(stored.signature),
      deps.ref,
      epoch,
      sealed,
    );

    // View, comment and edit are one key, so a reader could produce ciphertext that opens
    // for everybody. The signature is what makes an edit somebody's rather than anybody's.
    if (verdict !== 'valid') {
      deps.onNotice({ kind: 'unverified', userId: authorId });
      return;
    }

    const update = await decryptUpdate(deps.key, sealed, deps.ref, epoch);
    if (isLocked(update)) return;

    Y.applyUpdate(doc, update, REMOTE);

    if (stored.seq > lastSeq) lastSeq = stored.seq;
  }

  return {
    join(): void {
      deps.send(openFrame(deps.fileId, currentEpoch, lastSeq));
    },

    async receive(frame: ServerFrame): Promise<void> {
      if (closed || (frame.file_id !== undefined && frame.file_id !== deps.fileId)) return;

      switch (frame.type) {
        case 'absent':
          await seed();
          break;

        case 'doc':
          await adopt(frame);
          break;

        case 'update':
          if (frame.epoch === currentEpoch) {
            await apply(
              {
                seq: frame.seq ?? 0,
                payload: frame.payload ?? '',
                nonce: frame.nonce ?? '',
                ...(frame.user_id === undefined ? {} : { author_id: frame.user_id }),
                ...(frame.signature === undefined ? {} : { signature: frame.signature }),
              },
              currentEpoch,
            );
          }

          break;

        case 'ack':
          if (frame.seq !== undefined && frame.seq > lastSeq) lastSeq = frame.seq;
          break;

        case 'reseed':
          // What this client holds belongs to a document that no longer exists. Starting
          // again is the only honest move: merging it into the replacement would apply
          // edits to text they were never written against.
          currentEpoch = 0;
          lastSeq = 0;
          seeding = false;
          deps.onNotice({ kind: 'reseed' });
          deps.send(openFrame(deps.fileId, 0, 0));

          break;

        case 'error':
          deps.onNotice({
            kind: 'error',
            code: frame.code ?? 'error',
            message: frame.message ?? '',
          });

          break;

        default:
        // presence is handled by the store, which owns the peer list.
      }
    },

    async publishAwareness(state: Uint8Array): Promise<void> {
      if (closed || currentEpoch === 0) return;

      const sealed = await encryptPresence(deps.key, state, deps.ref);

      deps.send(awarenessFrame(deps.fileId, sealed));
    },

    async openAwareness(frame: ServerFrame): Promise<Uint8Array | null> {
      const sealed = openSealed(frame.payload, frame.nonce);
      if (!sealed) return null;

      const state = await decryptPresence(deps.key, sealed, deps.ref);

      return isLocked(state) ? null : state;
    },

    async snapshot(): Promise<{ sealed: SealedWire; epoch: number; uptoSeq: number } | null> {
      if (!doc || currentEpoch === 0) return null;

      // Everything buffered goes out first: a snapshot that covers edits the server has
      // never seen would prune a log that does not contain them yet.
      await flush();

      const state = Y.encodeStateAsUpdate(doc);
      const sealed = await encryptUpdate(deps.key, state, deps.ref, currentEpoch);

      return { sealed, epoch: currentEpoch, uptoSeq: lastSeq };
    },

    text(): string {
      return ytext?.toString() ?? '';
    },

    ready(): boolean {
      return doc !== null && currentEpoch !== 0;
    },

    epoch(): number {
      return currentEpoch;
    },

    close(): void {
      closed = true;

      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }

      deps.send(closeFrame(deps.fileId));
      doc?.destroy();
      doc = null;
      ytext = null;
    },
  };
}
