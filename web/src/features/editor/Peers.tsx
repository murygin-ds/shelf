import { peerColour } from '@/collab/colour';
import type { PeerDto } from '@/api/realtime';
import { tip } from '@/ui/Tooltip';

import styles from './editor.module.css';

/**
 * Who else has this note open.
 *
 * The list comes from the server rather than from the carets: it holds the membership and
 * the display names already, so stating them here teaches it nothing new — and it means
 * somebody who has just opened the note appears immediately, before they have moved a
 * caret. The colours are derived from the account id, so everybody sees the same person in
 * the same colour without agreeing on anything.
 */
export function Peers({ peers, selfId }: { peers: PeerDto[]; selfId: number | undefined }) {
  const others = peers.filter((peer) => peer.user_id !== selfId);

  if (others.length === 0) return null;

  return (
    <span className={styles.peers}>
      {others.map((peer) => {
        const colour = peerColour(peer.user_id);
        const name = peer.display_name || peer.login;

        return (
          <span
            key={peer.user_id}
            className={styles.peer}
            style={{ background: colour.color }}
            {...tip(`${name} · ${peer.permission}${peer.committer ? ' · saving' : ''}`)}
          >
            {initials(name)}
          </span>
        );
      })}
    </span>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] ?? '').slice(0, 2).toUpperCase();

  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase();
}
