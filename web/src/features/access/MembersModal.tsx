import { type FormEvent, useEffect, useState } from 'react';

import * as collab from '@/api/collab';
import { describe } from '@/api/errors';
import * as groupsApi from '@/api/groups';
import type { RekeyProgress } from '@/api/rekey';
import type { Role } from '@/api/workspace';
import type { Identity } from '@/crypto/identity';
import { format, m, roleLabel } from '@/i18n';
import { usePrefs } from '@/store/prefs';
import { useSession } from '@/store/session';
import * as mcp from '@/api/mcp';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';
import { tip } from '@/ui/Tooltip';
import { useNamePrompt } from '@/ui/NamePrompt';

import styles from './access.module.css';

const ROLES: Role[] = ['admin', 'editor', 'viewer'];

export function MembersModal({ onClose }: { onClose: () => void }) {
  const { user, identity } = useSession();
  const { vaultId, vaults, keyring, rekey } = useWorkspace();

  const [members, setMembers] = useState<collab.MemberDto[]>([]);
  const [invites, setInvites] = useState<collab.InviteDto[]>([]);
  const [role, setRole] = useState<Role>('editor');
  const [code, setCode] = useState<string | null>(null);
  const [pending, setPending] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether this vault has handed its key to the server. It changes what the footer is
  // allowed to claim, and a footer that claims the wrong thing here is the worst kind of
  // wrong: it is the line somebody reads to decide whether to trust the rest.
  const [connected, setConnected] = useState(false);
  const [progress, setProgress] = useState<RekeyProgress | null>(null);
  const dismiss = useDismiss(onClose);

  const readOnly = usePrefs((state) => state.readOnly);

  const vault = vaults.find((v) => v.id === vaultId);
  const canManage = vault?.role === 'owner' || vault?.role === 'admin';
  // Who is here is a read; changing who is here seals keys and writes grants.
  const canChange = canManage && !readOnly;

  const reload = async () => {
    if (vaultId === null) return;

    void mcp.connector(vaultId).then((found) => setConnected(found !== null));

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
    if (vaultId === null || !vault || !keyring || readOnly) return;

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
        [{ id: vault.keyScopeId, clientId: vault.keyScopeClientId, version: vault.keyVersion }],
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
    if (vaultId === null || readOnly) return;

    try {
      await collab.setRole(vaultId, userId, next);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  const remove = async (userId: number) => {
    if (vaultId === null || readOnly) return;

    try {
      const removed = await collab.removeMember(vaultId, userId);
      setPending(removed.pending_rotation);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    }
  };

  // Rotating the vault key is what makes the revocation retroactive: every row under that
  // scope is written back under a key the removed member never held.
  const rotate = async () => {
    if (!identity || vaultId === null) return;

    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: 0 });

    try {
      await rekey({ scopeType: 'vault', scopeRefId: vaultId }, identity, setProgress);
      setPending([]);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={`${styles.modal} ${styles.wide}`}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{m.access.members.title}</div>
            <div className={styles.subtitle}>
              {m.access.members.subtitle(members.length, invites.length)}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className={styles.body}>
          {canManage && readOnly ? (
            <p className={styles.empty}>{m.access.members.readOnly}</p>
          ) : null}

          {canChange ? (
            <form className={styles.row} onSubmit={invite}>
              <span className={styles.input} style={{ display: 'flex', alignItems: 'center', color: 'var(--text-quiet)' }}>
                {m.access.members.inviteHint}
              </span>
              <select
                className={styles.select}
                value={role}
                onChange={(event) => setRole(event.target.value as Role)}
              >
                {ROLES.map((name) => (
                  <option key={name} value={name}>
                    {roleLabel(name)}
                  </option>
                ))}
              </select>
              <button className={styles.primary} type="submit" disabled={busy}>
                {busy ? m.access.members.sealing : m.access.members.createInvite}
              </button>
            </form>
          ) : null}

          {code ? (
            <>
              <div className={styles.code}>{code}</div>
              <div className={styles.note}>
                <Icon name="key" size={14} style={{ flex: 'none', marginTop: 2, color: 'var(--warn)' }} />
                <span>{m.access.members.codeNote}</span>
              </div>
            </>
          ) : null}

          {error ? <div className={styles.error}>{error}</div> : null}

          {pending.length ? (
            <div className={`${styles.note} ${styles.noteWarn}`}>
              <Icon name="warn" size={14} style={{ flex: 'none', marginTop: 2 }} />
              <span className={styles.noteBody}>
                <span>{m.access.members.revoked(pending.length)}</span>

                {readOnly ? null : (
                  <button
                    type="button"
                    className={styles.noteAction}
                    disabled={busy || !identity}
                    onClick={() => void rotate()}
                  >
                    {m.access.rotateVaultKey}
                  </button>
                )}

                {progress ? (
                  <span className={styles.progress}>
                    {m.access.reencrypting(progress.done, progress.total)}
                  </span>
                ) : null}
              </span>
            </div>
          ) : null}

          <Groups members={members} />

          <div className={styles.section}>{m.access.members.section}</div>

          <div className={styles.gridHead}>
            <span>{m.access.members.columns.member}</span>
            <span>{m.access.members.columns.role}</span>
            <span>{m.access.members.columns.folders}</span>
            <span>{m.access.members.columns.key}</span>
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
                      <span className={`${styles.fingerprint} ${styles.caps}`}>
                        {m.access.members.you}
                      </span>
                    ) : null}
                  </span>
                  <span className={styles.personMeta} style={{ display: 'block' }}>
                    {member.login}
                  </span>
                </span>
              </span>

              {canChange && member.role !== 'owner' && member.user_id !== user?.id ? (
                <select
                  className={styles.select}
                  value={member.role}
                  onChange={(event) => void change(member.user_id, event.target.value as Role)}
                >
                  {ROLES.map((name) => (
                    <option key={name} value={name}>
                      {roleLabel(name)}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={styles.cell}>{roleLabel(member.role)}</span>
              )}

              <span className={styles.cell}>
                {member.folder_count > 0 ? member.folder_count : m.access.members.allFolders}
              </span>

              {/* The server hands out public keys, so it could hand out its own. Comparing
                  this out of band is the only thing that rules that out. */}
              <span className={styles.fingerprint} {...tip(m.access.members.fingerprintTip)}>
                {member.fingerprint}
              </span>

              {canChange && member.role !== 'owner' && member.user_id !== user?.id ? (
                <button
                  type="button"
                  className={styles.rowAction}
                  {...tip(m.access.members.removeTip)}
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
              <div className={styles.section}>{m.access.members.invites}</div>
              {invites.map((item) => (
                <div key={item.id} className={styles.person}>
                  <span className={styles.avatar} style={{ background: '#2a2620', color: '#c0a47a' }}>
                    <Icon name="key" size={13} />
                  </span>
                  <span className={styles.personMain}>
                    <span className={styles.personName}>
                      {item.email_hint || m.access.members.anyoneWithCode}
                      <span className={`${styles.pill} ${styles.caps}`}>
                        {m.access.members.pending}
                      </span>
                    </span>
                    <span className={styles.personMeta} style={{ display: 'block' }}>
                      {m.access.members.inviteMeta(roleLabel(item.role), format.date(item.expires_at))}
                    </span>
                  </span>
                  {canChange ? (
                    <button
                      type="button"
                      className={styles.rowAction}
                      {...tip(m.access.members.revokeTip)}
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
            {connected ? m.access.members.footerConnected : m.access.members.footerAlone}
          </span>
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

/**
 * Groups, and the one thing about them worth showing: adding somebody costs one seal
 * whatever the group reaches, while removing somebody replaces the group's key and every
 * scope sealed to it. The version number is how that shows up.
 */
function Groups({ members }: { members: collab.MemberDto[] }) {
  const { vaultId, vaults, keyring } = useWorkspace();
  const identity = useSession((state) => state.identity);
  const readOnly = usePrefs((state) => state.readOnly);

  const [groups, setGroups] = useState<groupsApi.Group[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { ask, dialog } = useNamePrompt();

  const vault = vaults.find((v) => v.id === vaultId);
  const canManage = vault?.role === 'owner' || vault?.role === 'admin';
  const scope = vault ? { id: vault.keyScopeId, version: vault.keyVersion } : null;

  const reload = async () => {
    if (vaultId === null || !keyring || !scope) return;

    try {
      setGroups(await groupsApi.listGroups(vaultId, keyring, scope));
    } catch (cause) {
      setError(describe(cause));
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultId, keyring]);

  const create = async () => {
    if (vaultId === null || !keyring || !scope || readOnly) return;

    const name = await ask(m.access.groups.namePrompt, m.access.groups.nameSample);
    if (!name) return;

    setBusy(true);
    setError(null);

    try {
      // The creator is always a founding member: the private key exists only in the copies
      // sealed here, and a group its own manager cannot open can never be added to.
      const me = members.find((member) => member.user_id === identityUser(members, identity));

      await groupsApi.createGroup(vaultId, name.trim(), me ? [me] : [], keyring, scope);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (group: groupsApi.Group, member: collab.MemberDto) => {
    if (!identity || !keyring || readOnly) return;

    const inside = group.members.some((existing) => existing.user_id === member.user_id);

    const next = inside
      ? members.filter((m) => group.members.some((e) => e.user_id === m.user_id) && m.user_id !== member.user_id)
      : [...members.filter((m) => group.members.some((e) => e.user_id === m.user_id)), member];

    setBusy(true);
    setError(null);

    try {
      await groupsApi.setGroupMembers(group, next, identity, keyring);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const disband = async (group: groupsApi.Group) => {
    if (readOnly) return;

    setBusy(true);
    setError(null);

    try {
      await groupsApi.deleteGroup(group.id);
      await reload();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!canManage) return null;

  return (
    <>
      {dialog}

      <div className={styles.section}>{m.access.groups.section(groups.length)}</div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {groups.length === 0 ? (
        <p className={styles.empty}>{m.access.groups.empty}</p>
      ) : (
        groups.map((group) => (
          <div key={group.id} className={styles.person}>
            <span className={styles.avatar}>{initials(group.name)}</span>
            <span className={styles.personMain}>
              <span className={styles.personName}>{group.name}</span>
              <span className={styles.personMeta} style={{ display: 'block' }}>
                {m.access.groups.meta(group.members.length, group.keyVersion)}
              </span>
            </span>

            {readOnly ? null : (
              <>
                <select
                  className={styles.select}
                  value=""
                  disabled={busy}
                  onChange={(event) => {
                    const member = members.find((m) => String(m.user_id) === event.target.value);
                    if (member) void toggle(group, member);
                  }}
                >
                  <option value="">{m.access.groups.pick}</option>
                  {members.map((member) => (
                    <option key={member.user_id} value={member.user_id}>
                      {group.members.some((e) => e.user_id === member.user_id) ? '− ' : '+ '}
                      {member.display_name}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className={styles.rowAction}
                  {...tip(m.access.groups.disbandTip)}
                  disabled={busy}
                  onClick={() => void disband(group)}
                >
                  <Icon name="x" size={14} />
                </button>
              </>
            )}
          </div>
        ))
      )}

      {readOnly ? null : (
        <button
          type="button"
          className={styles.noteAction}
          disabled={busy}
          onClick={() => void create()}
        >
          {m.access.groups.create}
        </button>
      )}
    </>
  );
}

// The member row for whoever is signed in, matched by the fingerprint of their own key —
// the one thing the client can compare without trusting the server's idea of who it is.
function identityUser(members: collab.MemberDto[], identity: Identity | null): number | undefined {
  return members.find((member) => member.fingerprint === identity?.fingerprint)?.user_id;
}
