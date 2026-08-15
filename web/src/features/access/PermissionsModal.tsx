import { useEffect, useState } from 'react';

import { ApiError } from '@/api/client';
import * as collab from '@/api/collab';
import type { FolderNode, Permission } from '@/api/workspace';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './access.module.css';

const LEVELS: Array<{ value: Permission; label: string }> = [
  { value: 'own', label: 'Can manage' },
  { value: 'edit', label: 'Can edit' },
  { value: 'comment', label: 'Can comment' },
  { value: 'view', label: 'Can view' },
  { value: 'none', label: 'No access' },
];

export function PermissionsModal({
  folder,
  onClose,
}: {
  folder: FolderNode;
  onClose: () => void;
}) {
  const { vaultId, vaults, keyring, syncNow } = useWorkspace();

  const [members, setMembers] = useState<collab.MemberDto[]>([]);
  const [grants, setGrants] = useState<collab.GrantDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const vault = vaults.find((v) => v.id === vaultId);
  const canManage = folder.permission === 'own';

  // The folder sits under the vault's key until it is given one of its own, which is what
  // makes a narrowing here server-enforced rather than cryptographic.
  const inheritsKey = !folder.ownScope;

  const reload = async () => {
    if (vaultId === null) return;

    try {
      const [people, list] = await Promise.all([
        collab.listMembers(vaultId),
        collab.listGrants(vaultId, 'folder', folder.id),
      ]);

      setMembers(people.members);
      setGrants(list.grants);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, folder.id]);

  const apply = async (member: collab.MemberDto, permission: Permission) => {
    if (vaultId === null || !vault || !keyring) return;

    setBusy(true);
    setError(null);

    try {
      await collab.putGrant(
        vaultId,
        {
          scopeType: 'folder',
          scopeRefId: folder.id,
          scope: { id: folder.keyScopeId, version: folder.keyVersion },
          // The seal names the scope holding this folder's key, which the server reports
          // alongside the node — deriving it from the folder or the vault would be a guess.
          scopeClientId: folder.keyScopeClientId,
        },
        member.user_id,
        permission,
        member.public_key,
        keyring,
      );

      await reload();
      await syncNow();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (grantId: number) => {
    if (vaultId === null) return;

    try {
      await collab.deleteGrant(vaultId, grantId);
      await reload();
      await syncNow();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const effective = (member: collab.MemberDto): Permission => {
    const grant = grants.find(
      (item) => item.subject_type === 'user' && item.subject_id === member.user_id,
    );

    if (grant) return grant.permission;

    return member.role === 'owner' || member.role === 'admin'
      ? 'own'
      : member.role === 'editor'
        ? 'edit'
        : 'view';
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(event) => event.stopPropagation()}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Permissions — {folder.name}</div>
            <div className={styles.subtitle}>
              Folder · {grants.length} override{grants.length === 1 ? '' : 's'} on this node
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {inheritsKey ? (
            <div className={`${styles.note} ${styles.noteWarn}`}>
              <Icon name="warn" size={14} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                This folder is encrypted with the vault key, so narrowing access here is
                enforced by the server only — everyone who already holds that key still holds
                it. Giving the folder its own key is what makes a denial real, and it arrives
                with key rotation.
              </span>
            </div>
          ) : (
            <div className={styles.note}>
              <Icon name="lock" size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--ok)' }} />
              <span>This folder has its own key, so a denial here is cryptographic.</span>
            </div>
          )}

          {error ? <div className={styles.error}>{error}</div> : null}

          <div className={styles.section}>WHO HAS ACCESS · {members.length}</div>

          {members.map((member) => {
            const grant = grants.find(
              (item) => item.subject_type === 'user' && item.subject_id === member.user_id,
            );
            const locked = member.role === 'owner' || !canManage;

            return (
              <div key={member.user_id} className={styles.person}>
                <span className={styles.avatar}>{initials(member.display_name)}</span>
                <span className={styles.personMain}>
                  <span className={styles.personName}>{member.display_name}</span>
                  <span className={styles.personMeta} style={{ display: 'block' }}>
                    {grant ? 'set on this folder' : `inherited from ${member.role}`}
                  </span>
                </span>

                {locked ? (
                  <span className={styles.cell}>{label(effective(member))}</span>
                ) : (
                  <select
                    className={styles.select}
                    value={effective(member)}
                    disabled={busy}
                    onChange={(event) => void apply(member, event.target.value as Permission)}
                  >
                    {LEVELS.map((level) => (
                      <option key={level.value} value={level.value}>
                        {level.label}
                      </option>
                    ))}
                  </select>
                )}

                {grant && canManage ? (
                  <button
                    type="button"
                    className={styles.rowAction}
                    title="Reset to inherited"
                    onClick={() => void clear(grant.id)}
                  >
                    <Icon name="x" size={14} />
                  </button>
                ) : (
                  <span style={{ width: 22 }} />
                )}
              </div>
            );
          })}

          {members.length <= 1 ? (
            <p className={styles.empty}>
              Nobody else is in this vault yet. Invite someone from Members &amp; access first.
            </p>
          ) : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>WIDENING SEALS THE FOLDER KEY TO THAT MEMBER</span>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.done} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function label(permission: Permission): string {
  return LEVELS.find((level) => level.value === permission)?.label ?? permission;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;

  return cause instanceof Error ? cause.message : 'Something went wrong.';
}
