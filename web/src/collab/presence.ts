/**
 * Who else is in this note, and where their carets are.
 *
 * The split is deliberate. Who is here — the account, the login, the display name — is
 * something the server already holds and states itself, in the presence frame. Where the
 * carets are is not: a caret position is the length of the document and the place somebody
 * is working in, so it travels sealed under the same key as the text.
 *
 * The identity attached to a caret is the server's word, not the sender's. Awareness is
 * rewritten several times a second and signing every frame would cost an ECDSA operation
 * per twitch for a claim nobody would check; instead the payload's own idea of who wrote
 * it is discarded and replaced with the sender the relay named. A tab cannot appear as
 * somebody else, whatever it puts in the blob.
 */

import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

import type { PeerDto, ServerFrame } from '@/api/realtime';

import { peerColour } from './colour';
import type { Room } from './room';

/** What yCollab reads to draw a remote caret. */
export interface PresenceUser {
  id: number;
  name: string;
  color: string;
  colorLight: string;
}

export interface Presence {
  awareness: Awareness;
  /** Announces this client's own caret. */
  publish(): void;
  /** Takes somebody else's, attributing it to whoever the server says sent it. */
  accept(frame: ServerFrame): Promise<void>;
  /** Drops the carets of everybody the presence frame no longer lists. */
  retain(peers: PeerDto[]): void;
  destroy(): void;
}

export interface PresenceDeps {
  doc: Y.Doc;
  /** The shared text, for re-anchoring an arriving caret. */
  text: Y.Text;
  room: Room;
  self: { userId: number; name: string };
  /** Names by account id, from the presence frame. */
  nameOf(userId: number): string;
}

/** Marks the states this module applied, so publishing does not echo them back. */
const REMOTE = 'remote-presence';

export function createPresence(deps: PresenceDeps): Presence {
  const awareness = new Awareness(deps.doc);

  awareness.setLocalStateField('user', {
    id: deps.self.userId,
    name: deps.self.name,
    ...peerColour(deps.self.userId),
  } satisfies PresenceUser);

  // Which Yjs client belongs to which account, learned from the relay rather than claimed
  // in the payload. It is what lets a caret be re-attributed after it is applied.
  const owners = new Map<number, number>();

  const publish = (): void => {
    const state = encodeAwarenessUpdate(awareness, [deps.doc.clientID]);

    void deps.room.publishAwareness(state);
  };

  /**
   * Re-anchors an arriving caret to the character on its left.
   *
   * y-codemirror.next encodes a caret with the default association, which binds it to the
   * character on its *right*. That makes somebody else's caret ride along with whatever you
   * type at exactly that spot — press Enter under it and it follows your text onto the new
   * line, which reads as them having moved when they have not.
   *
   * It is done on arrival rather than before sending, because the local `cursor` field
   * belongs to the y-codemirror plugin: it rewrites the field whenever the value differs
   * from the selection it computed, so anything written there is overwritten again on the
   * next update — and the two rewriting each other is what makes carets stop appearing at
   * all. What arrives is ours to place.
   */
  function anchorLeft(cursor: unknown): unknown {
    const range = cursor as { anchor?: unknown; head?: unknown } | null | undefined;
    if (!range?.anchor || !range.head) return cursor;

    try {
      const anchor = leftOf(range.anchor);
      const head = leftOf(range.head);

      return anchor && head ? { anchor, head } : cursor;
    } catch {
      // A position that no longer resolves belongs to a document this client has replaced.
      // Leaving it as it came is harmless: the plugin drops what it cannot place.
      return cursor;
    }
  }

  function leftOf(position: unknown): Y.RelativePosition | null {
    const absolute = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON(position),
      deps.doc,
    );

    if (!absolute || absolute.type !== deps.text) return null;

    return Y.createRelativePositionFromTypeIndex(deps.text, absolute.index, -1);
  }

  const onUpdate = (_: unknown, origin: unknown): void => {
    if (origin === REMOTE) return;

    publish();
  };

  awareness.on('update', onUpdate);

  return {
    awareness,

    publish,

    async accept(frame: ServerFrame): Promise<void> {
      const state = await deps.room.openAwareness(frame);
      if (!state || frame.user_id === undefined) return;

      const before = new Set(awareness.getStates().keys());

      applyAwarenessUpdate(awareness, state, REMOTE);

      // Everything this frame introduced or moved belongs to the account the server named,
      // whatever the payload says about itself.
      for (const [clientId, entry] of awareness.getStates()) {
        if (clientId === deps.doc.clientID) continue;
        if (before.has(clientId) && owners.get(clientId) !== frame.user_id) continue;

        owners.set(clientId, frame.user_id);

        const record = entry as { user?: PresenceUser; cursor?: unknown };

        record.user = {
          id: frame.user_id,
          name: deps.nameOf(frame.user_id),
          ...peerColour(frame.user_id),
        };

        if (record.cursor) record.cursor = anchorLeft(record.cursor);
      }
    },

    retain(peers: PeerDto[]): void {
      const present = new Set(peers.map((peer) => peer.user_id));

      const gone = [...owners.entries()]
        .filter(([, userId]) => !present.has(userId))
        .map(([clientId]) => clientId);

      if (gone.length === 0) return;

      for (const clientId of gone) owners.delete(clientId);

      // Without this a caret stays where the tab that owned it was when it closed.
      removeAwarenessStates(awareness, gone, REMOTE);
    },

    destroy(): void {
      awareness.off('update', onUpdate);
      awareness.destroy();
    },
  };
}
