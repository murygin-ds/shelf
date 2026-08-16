import { decrypt, encrypt, exportKey } from '@/crypto/aead';
import { b64ToBytes, bytesToB64, fromUtf8, utf8, type B64 } from '@/crypto/bytes';
import { sealInfo } from '@/crypto/envelope';
import {
  generateGroupKeypair,
  type GroupKeypair,
  importGroupPublic,
  openGroupKey,
  sealGroupKey,
} from '@/crypto/group';
import type { Identity } from '@/crypto/identity';
import type { GroupKeyDto, ScopeKeyring } from '@/crypto/keyring';
import { seal } from '@/crypto/sealedbox';

import { api } from './client';
import type { MemberDto } from './collab';

export interface GroupMemberDto {
  user_id: number;
  login: string;
  display_name: string;
  fingerprint: string;
  key_version: number;
}

export interface GroupDto {
  id: number;
  client_id: string;
  vault_id: number;
  meta: B64;
  meta_nonce: B64;
  public_key: B64;
  key_version: number;
  members: GroupMemberDto[];
  created_at: string;
}

/** A group after its name has been decrypted. */
export interface Group {
  id: number;
  clientId: string;
  vaultId: number;
  name: string;
  locked: boolean;
  publicKey: B64;
  keyVersion: number;
  members: GroupMemberDto[];
}

/**
 * A group's name is encrypted like everything else, under the vault key rather than the
 * group's own: the members table has to render it for people who are not in the group.
 */
function groupAAD(clientId: string): Uint8Array {
  return utf8(`shelf/group-meta/v1|${clientId}`);
}

export async function listGroups(
  vaultId: number,
  keyring: ScopeKeyring,
  vaultScope: { id: number; version: number },
): Promise<Group[]> {
  const { groups } = await api.get<{ groups: GroupDto[] }>(`/vaults/${vaultId}/groups`);
  const key = keyring.get(vaultScope.id, vaultScope.version);

  return Promise.all(
    groups.map(async (dto): Promise<Group> => {
      let name = '••••••';
      let locked = true;

      if (key) {
        try {
          const opened = await decrypt(
            key,
            { ciphertext: b64ToBytes(dto.meta), nonce: b64ToBytes(dto.meta_nonce) },
            groupAAD(dto.client_id),
          );

          name = (JSON.parse(fromUtf8(opened)) as { name: string }).name;
          locked = false;
        } catch {
          // A name this reader cannot open is the same state a locked note is in.
        }
      }

      return {
        id: dto.id,
        clientId: dto.client_id,
        vaultId: dto.vault_id,
        name,
        locked,
        publicKey: dto.public_key,
        keyVersion: dto.key_version,
        members: dto.members,
      };
    }),
  );
}

export function groupKeys(vaultId: number): Promise<{ keys: GroupKeyDto[] }> {
  return api.get<{ keys: GroupKeyDto[] }>(`/vaults/${vaultId}/group-keys`);
}

export interface GroupScopeDto {
  scope_id: number;
  scope_client_id: string;
  key_version: number;
}

/**
 * Every key the group holds, version by version.
 *
 * A rotation replaces all of them, and only the server knows the full set: a scope that has
 * itself been re-keyed leaves the group holding the old version as well as the new, because
 * revisions and trashed rows are still sealed under the old one.
 */
export function groupScopes(groupId: number): Promise<{ scopes: GroupScopeDto[] }> {
  return api.get<{ scopes: GroupScopeDto[] }>(`/groups/${groupId}/scopes`);
}

/**
 * Opens a group.
 *
 * The keypair is generated here and its private half sealed to each founding member. That
 * is what makes a group cheap to join later: a scope key is sealed to the group once, and
 * adding somebody is one more copy of this key rather than one copy per folder.
 */
export async function createGroup(
  vaultId: number,
  name: string,
  members: MemberDto[],
  keyring: ScopeKeyring,
  vaultScope: { id: number; version: number },
): Promise<GroupDto> {
  const key = keyring.get(vaultScope.id, vaultScope.version);
  if (!key) throw new Error('you do not hold this vault key');

  const clientId = crypto.randomUUID();
  const keypair = await generateGroupKeypair();
  const meta = await encrypt(key, utf8(JSON.stringify({ name })), groupAAD(clientId));

  return api.post<GroupDto>(`/vaults/${vaultId}/groups`, {
    client_id: clientId,
    meta: bytesToB64(meta.ciphertext),
    meta_nonce: bytesToB64(meta.nonce),
    public_key: bytesToB64(keypair.publicRaw),
    members: await sealTo(keypair, members, clientId, 1),
  });
}

export function deleteGroup(groupId: number): Promise<void> {
  return api.delete<void>(`/groups/${groupId}`);
}

/**
 * Replaces a group's members.
 *
 * Adding is one seal each. Removing is not: the person leaving already holds the group's
 * private key, so it has to be replaced and every scope the group reaches sealed again —
 * which only somebody holding the old key can do, and is why this needs the keyring.
 */
export async function setGroupMembers(
  group: Group,
  members: MemberDto[],
  identity: Identity,
  keyring: ScopeKeyring,
): Promise<GroupDto> {
  const removing = group.members.some(
    (existing) => !members.some((member) => member.user_id === existing.user_id),
  );

  if (!removing) {
    const keypair = await currentKeypair(group, identity);

    return api.put<GroupDto>(`/groups/${group.id}/members`, {
      members: await sealTo(keypair, members, group.clientId, group.keyVersion),
    });
  }

  const version = group.keyVersion + 1;
  const replacement = await generateGroupKeypair();

  // The list comes from the server, not from what this reader can see: a manager denied one
  // folder would otherwise miss it, and a scope that has been re-keyed is held at more than
  // one version. Anything missed is refused rather than silently dropped.
  const { scopes } = await groupScopes(group.id);
  const keyGrants = [];

  for (const scope of scopes) {
    const scopeKey = keyring.get(scope.scope_id, scope.key_version);

    if (!scopeKey) {
      throw new Error(
        'You hold no key for something this group can read, so its key cannot be replaced. ' +
          'Ask somebody with access to that folder to remove the member.',
      );
    }

    const box = await seal(
      replacement.publicRaw,
      await exportKey(scopeKey),
      sealInfo(scope.scope_client_id, scope.key_version),
    );

    keyGrants.push({
      scope_id: scope.scope_id,
      key_version: scope.key_version,
      wrapped_key: bytesToB64(box.blob),
      nonce: bytesToB64(box.nonce),
    });
  }

  return api.put<GroupDto>(`/groups/${group.id}/members`, {
    members: await sealTo(replacement, members, group.clientId, version),
    public_key: bytesToB64(replacement.publicRaw),
    key_grants: keyGrants,
  });
}

/** Recovers the group's keypair from the caller's own sealed copy. */
async function currentKeypair(group: Group, identity: Identity): Promise<GroupKeypair> {
  const { keys } = await groupKeys(group.vaultId);
  const mine = keys.find((key) => key.group_id === group.id);
  if (!mine) throw new Error('you are not in this group');

  const privateKey = await openGroupKey(
    identity,
    { blob: b64ToBytes(mine.wrapped_key), nonce: b64ToBytes(mine.nonce) },
    mine.group_client_id,
    mine.key_version,
  );

  return {
    privateKey,
    publicKey: await importGroupPublic(b64ToBytes(group.publicKey)),
    publicRaw: b64ToBytes(group.publicKey),
  };
}

async function sealTo(
  keypair: GroupKeypair,
  members: MemberDto[],
  clientId: string,
  version: number,
): Promise<Array<{ user_id: number; wrapped_key: B64; nonce: B64 }>> {
  const sealed = [];

  for (const member of members) {
    const box = await sealGroupKey(keypair, b64ToBytes(member.public_key), clientId, version);

    sealed.push({
      user_id: member.user_id,
      wrapped_key: bytesToB64(box.blob),
      nonce: bytesToB64(box.nonce),
    });
  }

  return sealed;
}
