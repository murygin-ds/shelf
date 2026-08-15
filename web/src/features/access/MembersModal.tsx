import { type FormEvent, useEffect, useState } from 'react';

import { ApiError } from '@/api/client';
import * as collab from '@/api/collab';
import type { Role } from '@/api/workspace';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './access.module.css';

const ROLES: Role[] = ['admin', 'editor', 'viewer'];

export function MembersModal({ onClose }: { onClose: () => void }) {
  const { user } = useSession();
  const { vaultId, vaults, keyring } = useWorkspace();

  const [members, setMembers] = useState<collab.MemberDto[]>([]);
  const [invites, setInvites] = useState<collab.InviteDto[]>([]);
  const [role, setRole] = useState<Role>('editor');
  const [code, setCode] = useState<string | null>(null);
  const [pending, setPending] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const vault = vaults.find((v) => v.id === vaultId);
  const canManage = vault?.role === 'owner' || vault?.role === 'admin';

  const reload = async () => {
    if (vaultId === null) return;

    try {
      setMembers((await collab.listMembers(vaultId)).members);
      if (canManage) setInvites((await collab.listInvites(vaultId)).invites);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId]);

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    if (vaultId === null || !vault || !keyring) return;

    setBusy(true);
    setError(null);

    try {
      const created = await collab.createCodeInvite(
        vaultId,
        role,
        {
          vaultName: vault.name,
          inviterName: user?.display_name ?? '',
          role,
          folders: [],
        },
        [
          {
            scope: { id: vault.keyScopeId, version: vault.keyVersion },
            scopeClientId: vault.keyScopeClientId,
          },
        ],
        keyring,
      );

      setCode(created.code);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const change = async (userId: number, next: Role) => {
    if (vaultId === null) return;

    try {
      await collab.setRole(vaultId, userId, next);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const remove = async (userId: number) => {
    if (vaultId === null) return;

    try {
      const removed = await collab.removeMember(vaultId, userId);
      setPending(removed.pending_rotation);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div
        className={`${styles.modal} ${styles.wide}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Members &amp; access</div>
            <div className={styles.subtitle}>
              {members.length} member{members.length === 1 ? '' : 's'}
              {invites.length ? ` · ${invites.length} pending invite` : ''}
              {invites.length > 1 ? 's' : ''} · seats unlimited on self-hosted
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {canManage ? (
            <form className={styles.row} onSubmit={invite}>
              <span className={styles.input} style={{ display: 'flex', alignItems: 'center', color: 'var(--text-quiet)' }}>
                A code invite — hand the code over yourself
              </span>
              <select
                className={styles.select}
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <button className={styles.primary} type="submit" disabled={busy}>
                {busy ? 'Sealing keys…' : 'Create invite'}
              </button>
            </form>
          ) : null}

          {code ? (
            <>
              <div className={styles.code}>{code}</div>
              <div className={styles.note}>
                <Icon name="key" size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--warn)' }} />
                <span>
                  Shown once — the server stores only its digest. Anyone holding this code can
                  join, so send it over a channel you trust rather than the one carrying the link.
                </span>
              </div>
            </>
          ) : null}

          {error ? <div className={styles.error}>{error}</div> : null}

          {pending.length ? (
            <div className={`${styles.note} ${styles.noteWarn}`}>
              <Icon name="warn" size={14} style={{ flex: 'none', marginTop: 2 }} />
              <span>
                Access was revoked immediately, which protects everything written from now on.
                It cannot un-read what was already read: {pending.length} key
                {pending.length === 1 ? '' : 's'} still need rotating for that.
              </span>
            </div>
          ) : null}

          <div className={styles.section}>MEMBERS</div>

          <div className={styles.gridHead}>
            <span>MEMBER</span>
            <span>ROLE</span>
            <span>FOLDERS</span>
            <span>KEY</span>
            <span />
          </div>

          {members.map((member) => (
            <div key={member.user_id} className={styles.grid}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span className={styles.avatar}>{initials(member.display_name)}</span>
                <span style={{ minWidth: 0 }}>
                  <span className={styles.personName}>
                    {member.display_name}
                    {member.user_id === user?.id ? (
                      <span className={styles.fingerprint}>YOU</span>
                    ) : null}
                  </span>
                  <span className={styles.personMeta} style={{ display: 'block' }}>
                    {member.login}
                  </span>
                </span>
              </span>

              {canManage && member.role !== 'owner' && member.user_id !== user?.id ? (
                <select
                  className={styles.select}
                  value={member.role}
                  onChange={(event) => void change(member.user_id, event.target.value as Role)}
                >
                  {ROLES.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={styles.cell}>{member.role}</span>
              )}

              <span className={styles.cell}>
                {member.folder_count > 0 ? member.folder_count : 'all'}
              </span>

              {/* The server hands out public keys, so it could hand out its own. Comparing
                  this out of band is the only thing that rules that out. */}
              <span className={styles.fingerprint} title="Key fingerprint — compare out of band">
                {member.fingerprint}
              </span>

              {canManage && member.role !== 'owner' && member.user_id !== user?.id ? (
                <button
                  type="button"
                  className={styles.rowAction}
                  title="Remove from vault"
                  onClick={() => void remove(member.user_id)}
                >
                  <Icon name="trash" size={14} />
                </button>
              ) : (
                <span />
              )}
            </div>
          ))}

          {invites.length ? (
            <>
              <div className={styles.section}>PENDING INVITES</div>
              {invites.map((item) => (
                <div key={item.id} className={styles.person}>
                  <span className={styles.avatar} style={{ background: '#2a2620', color: '#c0a47a' }}>
                    <Icon name="key" size={13} />
                  </span>
                  <span className={styles.personMain}>
                    <span className={styles.personName}>
                      {item.email_hint || 'Anyone with the code'}
                      <span className={styles.pill}>PENDING</span>
                    </span>
                    <span className={styles.personMeta} style={{ display: 'block' }}>
                      {item.role} · expires {new Date(item.expires_at).toLocaleDateString()}
                    </span>
                  </span>
                  {canManage ? (
                    <button
                      type="button"
                      className={styles.rowAction}
                      title="Revoke"
                      onClick={async () => {
                        if (vaultId === null) return;
                        await collab.revokeInvite(vaultId, item.id).catch(() => undefined);
                        await reload();
                      }}
                    >
                      <Icon name="x" size={14} />
                    </button>
                  ) : null}
                </div>
              ))}
            </>
          ) : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            KEYS ARE SEALED PER MEMBER · THE SERVER HOLDS NONE OF THEM
          </span>
          <span className={styles.footerSpacer} />
          <button type="button" className={styles.done} onClick={onClose}>
            Done
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

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;

  return cause instanceof Error ? cause.message : 'Something went wrong.';
}
