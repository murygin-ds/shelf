import { useEffect, useState } from 'react';

import * as audit from '@/api/audit';
import { ApiError } from '@/api/client';
import * as collab from '@/api/collab';
import type { RekeyProgress } from '@/api/rekey';
import { usePrefs } from '@/store/prefs';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';

import styles from './access.module.css';

export function SecurityModal({ onClose }: { onClose: () => void }) {
  const identity = useSession((state) => state.identity);
  const { vaultId, vaults, tree, rekey } = useWorkspace();

  const [events, setEvents] = useState<audit.AuditEventDto[]>([]);
  const [cursor, setCursor] = useState(0);
  const [exhausted, setExhausted] = useState(false);
  const dismiss = useDismiss(onClose);
  const [members, setMembers] = useState<collab.MemberDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RekeyProgress | null>(null);

  const readOnly = usePrefs((state) => state.readOnly);

  const vault = vaults.find((v) => v.id === vaultId);
  const canManage = vault?.role === 'owner' || vault?.role === 'admin';
  // The history is a read and stays; a rotation re-encrypts every row under the scope.
  const canRotate = canManage && !readOnly;
  const soloKeys = tree.folders.filter((folder) => folder.ownScope).length;

  const load = async (before = 0) => {
    if (vaultId === null || !canManage) return;

    try {
      const page = await audit.readAudit(vaultId, before);

      setEvents((current) => (before === 0 ? page.events : [...current, ...page.events]));
      setCursor(page.cursor);
      setExhausted(page.events.length === 0);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  useEffect(() => {
    if (vaultId === null) return;

    void load(0);
    void collab
      .listMembers(vaultId)
      .then((list) => setMembers(list.members))
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  const rotate = async () => {
    if (!identity || vaultId === null) return;

    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: 0 });

    try {
      await rekey({ scopeType: 'vault', scopeRefId: vaultId }, identity, setProgress);
      await load(0);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const stale = vault?.keyState === 'pending_rotation';

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={`${styles.modal} ${styles.wide}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Keys &amp; history</div>
            <div className={styles.subtitle}>
              {vault ? `${vault.name} · vault key v${vault.keyVersion}` : 'No vault'}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>VAULT KEY</div>

          <div className={styles.note}>
            <Icon
              name={stale ? 'warn' : 'lock'}
              size={14}
              style={{ flex: 'none', marginTop: 2, color: stale ? undefined : 'var(--ok)' }}
            />
            <span className={styles.noteBody}>
              <span>
                Version {vault?.keyVersion ?? 1}, wrapped for {members.length} member
                {members.length === 1 ? '' : 's'}. {soloKeys} folder
                {soloKeys === 1 ? '' : 's'} carry a key of their own and are untouched by a
                rotation here.
              </span>

              {stale ? (
                <span>
                  Somebody who held this key has been removed. Rotating it protects every
                  future read; it cannot un-read what they already opened.
                </span>
              ) : null}

              {canRotate ? (
                <button
                  type="button"
                  className={styles.noteAction}
                  disabled={busy || !identity}
                  onClick={() => void rotate()}
                >
                  {stale ? 'Rotate key & revoke old copies' : 'Rotate the vault key'}
                </button>
              ) : null}

              {canManage && readOnly ? (
                <span>Read-only mode is on, so the key cannot be rotated from this device.</span>
              ) : null}

              {progress ? (
                <span className={styles.progress}>
                  RE-ENCRYPTING {progress.done}/{progress.total || '…'}
                </span>
              ) : null}
            </span>
          </div>

          {error ? <div className={styles.error}>{error}</div> : null}

          <div className={styles.section}>ACCESS HISTORY</div>

          {!canManage ? (
            <p className={styles.empty}>
              The history records who works with whom, so it is kept to owners and admins.
            </p>
          ) : events.length === 0 ? (
            <p className={styles.empty}>Nothing has changed hands in this vault yet.</p>
          ) : (
            events.map((event) => (
              <div key={event.id} className={styles.person}>
                <span className={styles.avatar}>{initials(event.actor_name ?? '?')}</span>
                <span className={styles.personMain}>
                  <span className={styles.personName}>{describeEvent(event, tree)}</span>
                  <span className={styles.personMeta} style={{ display: 'block' }}>
                    {event.actor_name || event.actor_login || 'a removed account'} ·{' '}
                    {when(event.created_at)}
                  </span>
                </span>
                <span className={styles.pill}>{event.action}</span>
              </div>
            ))
          )}

          {canManage && events.length > 0 && !exhausted ? (
            <button
              type="button"
              className={styles.noteAction}
              onClick={() => void load(cursor)}
            >
              Load older
            </button>
          ) : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>THE SERVER KEEPS IDS, NOT NAMES</span>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.done} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Renders one entry against the reader's own tree. A node they cannot open has no name to
 * show, so it stays an id rather than borrowing one from somewhere it does not belong.
 */
function describeEvent(
  event: audit.AuditEventDto,
  tree: { folders: Array<{ id: number; name: string; locked: boolean }> },
): string {
  const target = () => {
    if (event.target_type === 'folder' && event.target_id !== undefined) {
      const folder = tree.folders.find((candidate) => candidate.id === event.target_id);

      return folder && !folder.locked ? `“${folder.name}”` : `folder #${event.target_id}`;
    }

    if (event.target_type === 'file') return `note #${event.target_id}`;

    return 'the vault';
  };

  switch (event.action) {
    case 'member.joined':
      return `joined as ${String(event.detail.role ?? 'a member')}`;
    case 'member.role_changed':
      return `changed a member's role to ${String(event.detail.role ?? '?')}`;
    case 'member.removed':
      return 'removed a member';
    case 'grant.set':
      return `set ${String(event.detail.permission ?? '?')} on ${target()}`;
    case 'grant.cleared':
      return 'reset a permission to inherited';
    case 'invite.created':
      return `opened ${event.detail.by_code ? 'a code invite' : 'an invite'}`;
    case 'invite.revoked':
      return 'revoked an invite';
    case 'key.protected':
      return `gave ${target()} a key of its own`;
    case 'key.rotated':
      return `rotated the key of ${target()} to v${String(event.detail.to_version ?? '?')}`;
    default:
      return event.action;
  }
}

function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;

  return new Date(iso).toLocaleDateString();
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message || `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.message || cause.name;

  return 'something went wrong';
}
