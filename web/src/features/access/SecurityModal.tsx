import { useEffect, useState } from 'react';

import * as audit from '@/api/audit';
import * as collab from '@/api/collab';
import { describe } from '@/api/errors';
import type { RekeyProgress } from '@/api/rekey';
import type { Permission, Role } from '@/api/workspace';
import { format, m, permissionLabel, roleLabel } from '@/i18n';
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
            <div className={styles.title}>{m.access.security.title}</div>
            <div className={`${styles.subtitle} truncate`}>
              {vault
                ? m.access.security.subtitle(vault.name, vault.keyVersion)
                : m.access.security.noVault}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>{m.access.security.section}</div>

          <div className={styles.note}>
            <Icon
              name={stale ? 'warn' : 'lock'}
              size={14}
              style={{ flex: 'none', marginTop: 2, color: stale ? undefined : 'var(--ok)' }}
            />
            <span className={styles.noteBody}>
              <span>
                {m.access.security.vaultKey(vault?.keyVersion ?? 1, members.length, soloKeys)}
              </span>

              {stale ? <span>{m.access.security.stale}</span> : null}

              {canRotate ? (
                <button
                  type="button"
                  className={styles.noteAction}
                  disabled={busy || !identity}
                  onClick={() => void rotate()}
                >
                  {stale ? m.access.security.rotateAndRevoke : m.access.rotateVaultKey}
                </button>
              ) : null}

              {canManage && readOnly ? <span>{m.access.security.readOnly}</span> : null}

              {progress ? (
                <span className={styles.progress}>
                  {m.access.reencrypting(progress.done, progress.total)}
                </span>
              ) : null}
            </span>
          </div>

          {error ? <div className={styles.error}>{error}</div> : null}

          <div className={styles.section}>{m.access.security.history}</div>

          {!canManage ? (
            <p className={styles.empty}>{m.access.security.historyPrivate}</p>
          ) : events.length === 0 ? (
            <p className={styles.empty}>{m.access.security.historyEmpty}</p>
          ) : (
            events.map((event) => (
              <div key={event.id} className={styles.person}>
                <span className={styles.avatar}>{initials(event.actor_name ?? '?')}</span>
                <span className={styles.personMain}>
                  <span className={styles.personName}>{describeEvent(event, tree)}</span>
                  <span className={styles.personMeta} style={{ display: 'block' }}>
                    {event.actor_name || event.actor_login || m.access.security.removedAccount} ·{' '}
                    {format.recent(event.created_at)}
                  </span>
                </span>
                <span className={styles.pill}>{m.access.audit.names[event.action]}</span>
              </div>
            ))
          )}

          {canManage && events.length > 0 && !exhausted ? (
            <button
              type="button"
              className={styles.noteAction}
              onClick={() => void load(cursor)}
            >
              {m.access.security.older}
            </button>
          ) : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>{m.access.security.footer}</span>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.done} onClick={onClose}>
            {m.common.done}
          </button>
        </div>
      </div>
    </div>
  );
}

interface Tree {
  folders: Array<{ id: number; name: string; locked: boolean }>;
}

/**
 * Renders one entry against the reader's own tree.
 *
 * The dictionary writes the whole sentence rather than handing back a verb for this to glue
 * a target onto: Russian declines the thing acted on, and which case it takes is the verb's
 * choice, not this function's.
 */
function describeEvent(event: audit.AuditEventDto, tree: Tree): string {
  const { actions, names } = m.access.audit;
  const target = () => describeTarget(event, tree);

  switch (event.action) {
    case 'member.joined':
      return actions['member.joined'](roleWord(event.detail.role));
    case 'member.role_changed':
      return actions['member.role_changed'](roleWord(event.detail.role));
    case 'member.removed':
      return actions['member.removed'];
    case 'grant.set':
      return actions['grant.set'](target(), permissionWord(event.detail.permission));
    case 'grant.cleared':
      return actions['grant.cleared'];
    case 'invite.created':
      return actions['invite.created'](Boolean(event.detail.by_code));
    case 'invite.revoked':
      return actions['invite.revoked'];
    case 'key.protected':
      return actions['key.protected'](target());
    case 'key.rotated':
      return actions['key.rotated'](target(), String(event.detail.to_version ?? '?'));
    default:
      return names[event.action];
  }
}

/** A node the reader cannot open has no name to show, so it stays an id. */
function describeTarget(event: audit.AuditEventDto, tree: Tree): string {
  const targets = m.access.audit.targets;

  if (event.target_type === 'folder' && event.target_id !== undefined) {
    const folder = tree.folders.find((candidate) => candidate.id === event.target_id);

    return folder && !folder.locked
      ? targets.folder(folder.name)
      : targets.folderId(event.target_id);
  }

  if (event.target_type === 'file') return targets.note(event.target_id);

  return targets.vault;
}

// `detail` holds whatever the server wrote there. A value no dictionary knows is left out of
// the sentence rather than printed raw, which is what the sentence templates expect of null.
function roleWord(value: unknown): string | null {
  return typeof value === 'string' && value in m.enums.role ? roleLabel(value as Role) : null;
}

function permissionWord(value: unknown): string | null {
  return typeof value === 'string' && value in m.enums.permission
    ? permissionLabel(value as Permission)
    : null;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

