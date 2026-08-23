import { useEffect, useState } from 'react';

import * as collab from '@/api/collab';
import { describe } from '@/api/errors';
import * as groupsApi from '@/api/groups';
import type { RekeyProgress } from '@/api/rekey';
import type { FolderNode, Permission } from '@/api/workspace';
import { m, permissionLabel, roleLabel } from '@/i18n';
import { usePrefs } from '@/store/prefs';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';
import { tip } from '@/ui/Tooltip';

import styles from './access.module.css';

/** Widest first: a list of permissions reads as a ladder, and the ladder starts at the top. */
const LEVELS: Permission[] = ['own', 'edit', 'comment', 'view', 'none'];

export function PermissionsModal({
  folder,
  onClose,
}: {
  folder: FolderNode;
  onClose: () => void;
}) {
  const { vaultId, vaults, keyring, syncNow, rekey } = useWorkspace();
  const identity = useSession((state) => state.identity);

  const [members, setMembers] = useState<collab.MemberDto[]>([]);
  const [groups, setGroups] = useState<groupsApi.Group[]>([]);
  const [grants, setGrants] = useState<collab.GrantDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<RekeyProgress | null>(null);
  const dismiss = useDismiss(onClose);

  const readOnly = usePrefs((state) => state.readOnly);

  const vault = vaults.find((v) => v.id === vaultId);
  // Every verb in here is a grant, a revocation or a re-key, so read-only turns the whole
  // panel into what it already is for a member who cannot manage the folder: a statement of
  // who has access.
  const canManage = folder.permission === 'own' && !readOnly;

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

      if (keyring && vault) {
        setGroups(
          await groupsApi.listGroups(vaultId, keyring, {
            id: vault.keyScopeId,
            version: vault.keyVersion,
          }),
        );
      }
    } catch (cause) {
      setError(describe(cause));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, folder.id]);

  const apply = async (member: collab.MemberDto, permission: Permission) => {
    if (vaultId === null || !vault || !keyring || readOnly) return;

    setBusy(true);
    setError(null);

    try {
      await collab.putGrant(
        vaultId,
        {
          scopeType: 'folder',
          scopeRefId: folder.id,
          // The scope is the one the server reports alongside the node; deriving it from
          // the folder or the vault would be a guess, and a wrong guess seals a key nobody
          // can open.
          scope: {
            id: folder.keyScopeId,
            clientId: folder.keyScopeClientId,
            version: folder.keyVersion,
          },
        },
        { type: 'user', id: member.user_id, publicKey: member.public_key },
        permission,
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

  // Re-encrypts the folder and everything under it with a key of its own, sealed only to
  // the people who still have access. It is the moment a denial stops depending on the
  // server behaving.
  const protectFolder = async () => {
    if (!identity) return;

    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: 0 });

    try {
      await rekey({ scopeType: 'folder', scopeRefId: folder.id }, identity, setProgress);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  // A group's key is its own, so the folder key is sealed to the group's public point
  // rather than to any person's — one seal, whoever joins later.
  const applyToGroup = async (group: groupsApi.Group, permission: Permission) => {
    if (vaultId === null || !keyring || readOnly) return;

    setBusy(true);
    setError(null);

    try {
      await collab.putGrant(
        vaultId,
        {
          scopeType: 'folder',
          scopeRefId: folder.id,
          scope: {
            id: folder.keyScopeId,
            clientId: folder.keyScopeClientId,
            version: folder.keyVersion,
          },
        },
        { type: 'group', id: group.id, publicKey: group.publicKey },
        permission,
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
    if (vaultId === null || readOnly) return;

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
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.modal}>
        <div className={styles.head}>
          <div>
            <div className={`${styles.title} truncate`}>
              {m.access.permissions.title(folder.name)}
            </div>
            <div className={styles.subtitle}>
              {m.access.permissions.subtitle(grants.length)}
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
              <span className={styles.noteBody}>
                <span>{m.access.permissions.inheritsKey}</span>

                {canManage ? (
                  <button
                    type="button"
                    className={styles.noteAction}
                    disabled={busy || !identity}
                    onClick={() => void protectFolder()}
                  >
                    {m.access.permissions.protect}
                  </button>
                ) : null}

                {progress ? (
                  <span className={styles.progress}>
                    {m.access.reencrypting(progress.done, progress.total)}
                  </span>
                ) : null}
              </span>
            </div>
          ) : (
            <div className={styles.note}>
              <Icon name="lock" size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--ok)' }} />
              <span>{m.access.permissions.ownKey}</span>
            </div>
          )}

          {error ? <div className={styles.error}>{error}</div> : null}

          <div className={styles.section}>
            {m.access.permissions.whoHasAccess(members.length)}
          </div>

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
                    {m.access.permissions.memberMeta(grant ? null : roleLabel(member.role))}
                  </span>
                </span>

                {locked ? (
                  <span className={styles.cell}>{permissionLabel(effective(member))}</span>
                ) : (
                  <select
                    className={styles.select}
                    value={effective(member)}
                    disabled={busy}
                    onChange={(event) => void apply(member, event.target.value as Permission)}
                  >
                    {LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {permissionLabel(level)}
                      </option>
                    ))}
                  </select>
                )}

                {grant && canManage ? (
                  <button
                    type="button"
                    className={styles.rowAction}
                    {...tip(m.access.permissions.resetTip)}
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

          {groups.length ? (
            <>
              <div className={styles.section}>{m.access.groups.section(groups.length)}</div>

              {groups.map((group) => {
                const grant = grants.find(
                  (item) => item.subject_type === 'group' && item.subject_id === group.id,
                );

                return (
                  <div key={group.id} className={styles.person}>
                    <span className={styles.avatar}>{initials(group.name)}</span>
                    <span className={styles.personMain}>
                      <span className={styles.personName}>{group.name}</span>
                      <span className={styles.personMeta} style={{ display: 'block' }}>
                        {m.access.permissions.groupMeta(grant !== undefined, group.members.length)}
                      </span>
                    </span>

                    {canManage ? (
                      <select
                        className={styles.select}
                        value={grant?.permission ?? 'none'}
                        disabled={busy}
                        onChange={(event) =>
                          void applyToGroup(group, event.target.value as Permission)
                        }
                      >
                        {LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {permissionLabel(level)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={styles.cell}>{permissionLabel(grant?.permission ?? 'none')}</span>
                    )}

                    <span style={{ width: 22 }} />
                  </div>
                );
              })}
            </>
          ) : null}

          {members.length <= 1 ? (
            <p className={styles.empty}>{m.access.permissions.alone}</p>
          ) : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>{m.access.permissions.footer}</span>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.done} onClick={onClose}>
            {m.common.done}
          </button>
        </div>
      </div>
    </div>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

