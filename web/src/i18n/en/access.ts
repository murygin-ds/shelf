/**
 * Members, permissions, keys and the access history.
 *
 * One shape here is not the usual "key holds a string". The history writes a whole sentence
 * per action rather than a verb, because Russian puts the thing acted on into whichever case
 * the verb governs — «ключ папки», but «доступ к папке» — and no concatenation of an English
 * verb, a preposition and a name arrives at that. The sentence takes the name of the target
 * and builds the rest itself.
 *
 * The action keys stay as the server writes them; only what is drawn changes. They live
 * here rather than in `enums` for the same reason: a bare word per action would have to be
 * bent at three of the call sites, and a shared entry that gets bent was never shared.
 */

import type { AuditAction } from '@/api/audit';

import { countedEn, pluralEn } from '../plural';

const SET_HERE = 'set on this folder';

export const access = {
  rotateVaultKey: 'Rotate the vault key',
  /** A vault-sized re-key runs for a while, and `total` is only known after the first page. */
  reencrypting: (done: number, total: number) => `Re-encrypting ${done}/${total || '…'}`,

  members: {
    title: 'Members & access',
    subtitle: (members: number, invites: number) =>
      `${countedEn(members, ['member', 'members'])}` +
      `${invites === 0 ? '' : ` · ${countedEn(invites, ['pending invite', 'pending invites'])}`}` +
      ' · seats unlimited on self-hosted',
    readOnly:
      'Read-only mode is on: this is who holds a key, and nothing here can be handed out or ' +
      'taken back from this device.',
    inviteHint: 'A code invite — hand the code over yourself',
    sealing: 'Sealing keys…',
    createInvite: 'Create invite',
    codeNote:
      'Shown once — the server stores only its digest. Anyone holding this code can join, so ' +
      'send it over a channel you trust rather than the one carrying the link.',
    revoked: (keys: number) =>
      'Access was revoked immediately, which protects everything written from now on. It ' +
      `cannot un-read what was already read: ${countedEn(keys, ['key', 'keys'])} still ` +
      `${pluralEn(keys, ['needs', 'need'])} rotating for that.`,
    section: 'Members',
    columns: {
      member: 'Member',
      role: 'Role',
      folders: 'Folders',
      key: 'Key',
    },
    you: 'You',
    allFolders: 'all',
    fingerprintTip: 'Key fingerprint — compare out of band',
    removeTip: 'Remove from vault',
    invites: 'Pending invites',
    anyoneWithCode: 'Anyone with the code',
    pending: 'Pending',
    inviteMeta: (role: string, expires: string) => `${role} · expires ${expires}`,
    revokeTip: 'Revoke',
    footerConnected: 'Keys are sealed per member · this server holds the connector’s',
    footerAlone: 'Keys are sealed per member · the server holds none of them',
  },

  groups: {
    section: (count: number) => `Groups · ${count}`,
    empty:
      'A group holds a permission on behalf of several people. Its key is sealed to each ' +
      'member, so adding somebody later costs one seal rather than one per folder.',
    meta: (members: number, keyVersion: number) =>
      `${countedEn(members, ['member', 'members'])} · key v${keyVersion}`,
    pick: 'Add or remove…',
    disbandTip: 'Disband',
    create: 'New group',
    namePrompt: 'Group name',
    /** Becomes the group's actual name when the suggestion is accepted, so it is content. */
    nameSample: 'Design',
  },

  permissions: {
    title: (folder: string) => `Permissions — ${folder}`,
    subtitle: (overrides: number) =>
      `Folder · ${countedEn(overrides, ['override', 'overrides'])} on this node`,
    inheritsKey:
      'This folder is encrypted with the vault key, so narrowing access here is enforced by ' +
      'the server only — everyone who already holds that key still holds it. Giving the ' +
      'folder its own key is what makes a denial real.',
    protect: 'Protect with its own key',
    ownKey: 'This folder has its own key, so a denial here is cryptographic.',
    whoHasAccess: (count: number) => `Who has access · ${count}`,
    memberMeta: (inheritedFrom: string | null) =>
      inheritedFrom === null ? SET_HERE : `inherited from ${inheritedFrom}`,
    resetTip: 'Reset to inherited',
    groupMeta: (granted: boolean, members: number) =>
      `${granted ? SET_HERE : 'no permission here'} · ${countedEn(members, ['member', 'members'])}`,
    alone: 'Nobody else is in this vault yet. Invite someone from Members & access first.',
    footer: 'Widening seals the folder key to that member',
  },

  security: {
    title: 'Keys & history',
    subtitle: (vault: string, keyVersion: number) => `${vault} · vault key v${keyVersion}`,
    noVault: 'No vault',
    section: 'Vault key',
    vaultKey: (keyVersion: number, members: number, soloKeys: number) => {
      const wrapped = `Version ${keyVersion}, wrapped for ${countedEn(members, ['member', 'members'])}.`;

      return soloKeys === 0
        ? `${wrapped} Nothing under it holds a key of its own, so a rotation here reaches the whole vault.`
        : `${wrapped} ${countedEn(soloKeys, ['folder', 'folders'])} ` +
            `${pluralEn(soloKeys, ['carries a key of its own', 'carry keys of their own'])}, ` +
            'which a rotation here does not touch.';
    },
    stale:
      'Somebody who held this key has been removed. Rotating it protects every future read; ' +
      'it cannot un-read what they already opened.',
    rotateAndRevoke: 'Rotate key & revoke old copies',
    readOnly: 'Read-only mode is on, so the key cannot be rotated from this device.',
    history: 'Access history',
    historyPrivate:
      'The history records who works with whom, so it is kept to owners and admins.',
    historyEmpty: 'Nothing has changed hands in this vault yet.',
    removedAccount: 'a removed account',
    older: 'Load older',
    footer: 'The server keeps ids, not names',
  },

  audit: {
    /**
     * The pill beside an entry. English shows the key the server wrote, which is what it
     * has always shown; a language that cannot read it gets a name for the category.
     */
    names: {
      'member.joined': 'member.joined',
      'member.role_changed': 'member.role_changed',
      'member.removed': 'member.removed',
      'grant.set': 'grant.set',
      'grant.cleared': 'grant.cleared',
      'invite.created': 'invite.created',
      'invite.revoked': 'invite.revoked',
      'key.protected': 'key.protected',
      'key.rotated': 'key.rotated',
    } as Record<AuditAction, string>,

    /**
     * One form per node, because one form is what all three sentences below were written to
     * take — in Russian the genitive: «ключ папки», «у папки», «для папки». A verb that
     * needed another case would get its own field here rather than a preposition glued on
     * by the caller, which is the whole reason the sentence is written here at all.
     */
    targets: {
      vault: 'the vault',
      folder: (name: string) => `“${name}”`,
      /** A node this reader cannot open keeps its id rather than borrowing a name. */
      folderId: (id: number | undefined) => `folder #${id ?? '?'}`,
      note: (id: number | undefined) => `note #${id ?? '?'}`,
    },

    actions: {
      'member.joined': (role: string | null) =>
        role === null ? 'joined as a member' : `joined as ${role}`,
      'member.role_changed': (role: string | null) =>
        role === null ? 'changed a member’s role' : `changed a member’s role to ${role}`,
      'member.removed': 'removed a member',
      'grant.set': (target: string, permission: string | null) =>
        permission === null
          ? `set a permission on ${target}`
          : `set “${permission}” on ${target}`,
      'grant.cleared': 'reset a permission to inherited',
      'invite.created': (byCode: boolean): string =>
        byCode ? 'opened a code invite' : 'opened an invite',
      'invite.revoked': 'revoked an invite',
      'key.protected': (target: string) => `gave ${target} a key of its own`,
      'key.rotated': (target: string, keyVersion: string) =>
        `rotated the key of ${target} to v${keyVersion}`,
    },
  },
};
