/**
 * The live editing session for the note that is open.
 *
 * It ties together the three things the store would otherwise have to hold: the document
 * and its updates (`room`), the carets (`presence`), and the periodic write-back of the
 * body — which only one client in the room performs, the one the server named committer.
 *
 * The write-back is what keeps everything that is not the editor working: search reads
 * `files.content`, so do revisions, public links, the offline cache and the delta feed.
 * Between commits the document is ahead of the body, and that is the price of a merge the
 * server cannot perform.
 */

import * as Y from 'yjs';

import type { PeerDto, ServerFrame } from '@/api/realtime';
import type { NoteNode } from '@/api/workspace';
import type { EntityRef } from '@/crypto/envelope';
import type { Identity } from '@/crypto/identity';
import type { CollabBinding } from '@/features/editor/MarkdownEditor';

import { createPresence, type Presence } from './presence';
import { createRoom, type Room, type RoomNotice } from './room';

/** Quiet time before the committer writes the body back. */
export const COMMIT_IDLE_MS = 2_000;

/** And the ceiling, so a session that never pauses still leaves revisions behind. */
export const COMMIT_MAX_MS = 15_000;

export interface SessionDeps {
  note: NoteNode;
  ref: EntityRef;
  scope: { keyScopeId: number; keyVersion: number };
  key: CryptoKey;
  identity: Identity;
  self: { userId: number; name: string };
  body: string;
  contentSeq: number;
  canEdit: boolean;
  send(frame: Record<string, unknown>): void;
  authorKey(userId: number): Uint8Array | null;
  /** Writes the body back. Called on the committer only. */
  commit(text: string, commit: { epoch: number; uptoSeq: number; snapshot: { ciphertext: Uint8Array; nonce: Uint8Array } }): Promise<void>;
  onBinding(binding: CollabBinding | null): void;
  onText(text: string): void;
  onPeers(peers: PeerDto[], committer: boolean): void;
  onNotice(notice: RoomNotice): void;
}

export interface EditingSession {
  /** Opens the note on the socket. Called again whenever the socket comes back. */
  join(): void;
  /** Takes a frame the socket delivered. */
  receive(frame: ServerFrame): Promise<void>;
  /** Writes the body back now, whether or not the timers were due. */
  flush(): Promise<void>;
  close(): void;
}

export function createSession(deps: SessionDeps): EditingSession {
  let presence: Presence | null = null;
  let committer = false;
  let peers: PeerDto[] = [];
  let closed = false;

  let idle: ReturnType<typeof setTimeout> | null = null;
  let ceiling: ReturnType<typeof setTimeout> | null = null;
  let committing: Promise<void> | null = null;

  const nameOf = (userId: number): string =>
    peers.find((peer) => peer.user_id === userId)?.display_name ?? '';

  const room: Room = createRoom({
    fileId: deps.note.id,
    ref: deps.ref,
    scope: deps.scope,
    key: deps.key,
    identity: deps.identity,
    body: deps.body,
    contentSeq: deps.contentSeq,
    canEdit: deps.canEdit,
    send: deps.send,
    authorKey: deps.authorKey,
    onReady: (doc, text) => {
      presence?.destroy();
      presence = createPresence({ doc, text, room, self: deps.self, nameOf });

      // The undo manager tracks only what this client wrote, which is the whole reason the
      // editor's own history is switched off while a room is up.
      const undoManager = new Y.UndoManager(text, { trackedOrigins: new Set([null, doc.clientID]) });

      deps.onBinding({ text, awareness: presence.awareness, undoManager });
    },
    onText: (text) => {
      deps.onText(text);
      schedule();
    },
    onNotice: deps.onNotice,
  });

  /** Arms the two timers a commit waits on. */
  function schedule(): void {
    if (closed || !committer) return;

    if (idle !== null) clearTimeout(idle);

    idle = setTimeout(() => void commit(), COMMIT_IDLE_MS);
    ceiling ??= setTimeout(() => void commit(), COMMIT_MAX_MS);
  }

  function disarm(): void {
    if (idle !== null) {
      clearTimeout(idle);
      idle = null;
    }

    if (ceiling !== null) {
      clearTimeout(ceiling);
      ceiling = null;
    }
  }

  /** Writes the body back. One at a time: two overlapping writes would fight the If-Match. */
  async function commit(): Promise<void> {
    disarm();

    if (closed || !committer || !room.ready()) return;

    committing ??= (async () => {
      const snapshot = await room.snapshot();
      if (!snapshot) return;

      await deps.commit(room.text(), {
        epoch: snapshot.epoch,
        uptoSeq: snapshot.uptoSeq,
        snapshot: snapshot.sealed,
      });
    })()
      .catch(() => {
        // The store reports what went wrong; a failed write-back leaves the document as the
        // truth, which is where it already was.
      })
      .finally(() => {
        committing = null;
      });

    return committing;
  }

  return {
    join(): void {
      room.join();
    },

    async receive(frame: ServerFrame): Promise<void> {
      if (closed) return;
      if (frame.file_id !== undefined && frame.file_id !== deps.note.id) return;

      if (frame.type === 'presence') {
        peers = frame.peers ?? [];

        const wasCommitter = committer;

        // The server's word about this socket, not about this person: two tabs of one
        // account are one entry in the list, and only one of them may write the body back.
        committer = frame.committing === true;

        presence?.retain(peers);
        deps.onPeers(peers, committer);

        // Promoted while the room had unsaved work: whoever held the job has gone, and
        // what they had not written back is still only in the document.
        if (committer && !wasCommitter) schedule();

        return;
      }

      if (frame.type === 'awareness') {
        await presence?.accept(frame);
        return;
      }

      await room.receive(frame);
    },

    async flush(): Promise<void> {
      await commit();
    },

    close(): void {
      closed = true;
      disarm();
      presence?.destroy();
      presence = null;
      deps.onBinding(null);
      room.close();
    },
  };
}
