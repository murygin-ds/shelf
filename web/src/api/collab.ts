import { exportKey } from '@/crypto/aead';
import { b64ToBytes, bytesToB64, type B64 } from '@/crypto/bytes';
import { sealInfo } from '@/crypto/envelope';
import { type Identity, splitPublicBlob } from '@/crypto/identity';
import {
  generateInviteCode,
  INVITE_WRAP_ALGORITHM,
  inviteKey,
  inviteToken,
  type InvitePreview,
  openPreview,
  sealPreview,
  unwrapScopeKey,
  wrapScopeKey,
} from '@/crypto/invite';
import type { ScopeKeyring } from '@/crypto/keyring';
import { seal } from '@/crypto/sealedbox';

import { api } from './client';
import type { Permission, Role, Scope } from './workspace';

export interface MemberDto {
  user_id: number;
  login: string;
  display_name: string;
  public_key: B64;
  fingerprint: string;
  role: Role;
  key_state: 'ok' | 'pending_key' | 'pending_rotation';
  folder_count: number;
  last_active: string | null;
  created_at: string;
}

export interface DirectoryDto {
  user_id: number;
  login: string;
  display_name: string;
  public_key: B64;
  fingerprint: string;
}

export interface GrantDto {
  id: number;
  scope_type: 'folder' | 'file';
  scope_ref_id: number;
  subject_type: 'user' | 'group';
  subject_id: number;
  subject_label: string;
  permission: Permission;
  created_at: string;
}

export interface InviteDto {
  id: number;
  vault_id: number;
  role: Role;
  email_hint: string;
  inviter_name: string;
  expires_at: string;
  redeemed_at: string | null;
  created_at: string;
}

interface SealedKeyDto {
  scope_id: number;
  scope_client_id: string;
  key_version: number;
  wrapped_key: B64;
  nonce: B64;
  wrap_algorithm: string;
}

export interface ChallengeDto {
  invite_id: number;
  wrapped_preview: B64;
  preview_nonce: B64;
  key_grants: SealedKeyDto[];
  expires_at: string;
}

export function listMembers(vaultId: number): Promise<{ members: MemberDto[] }> {
  return api.get<{ members: MemberDto[] }>(`/vaults/${vaultId}/members`);
}

export function lookupUser(login: string): Promise<DirectoryDto> {
  return api.get<DirectoryDto>(`/users/lookup?login=${encodeURIComponent(login)}`);
}

export function setRole(vaultId: number, userId: number, role: Role): Promise<void> {
  return api.patch<void>(`/vaults/${vaultId}/members/${userId}`, { role });
}

export function removeMember(
  vaultId: number,
  userId: number,
): Promise<{ pending_rotation: number[] }> {
  return api.delete<{ pending_rotation: number[] }>(`/vaults/${vaultId}/members/${userId}`);
}

export function listGrants(
  vaultId: number,
  scopeType: 'folder' | 'file',
  scopeRefId: number,
): Promise<{ grants: GrantDto[] }> {
  return api.get<{ grants: GrantDto[] }>(
    `/vaults/${vaultId}/grants?scope_type=${scopeType}&scope_ref_id=${scopeRefId}`,
  );
}

/**
 * Sets a subject's permission on one node.
 *
 * Widening carries the scope key sealed to that subject: the server refuses a grant that
 * would let someone see a node they can never open, and rightly so.
 */
export async function putGrant(
  vaultId: number,
  target: { scopeType: 'folder' | 'file'; scopeRefId: number; scope: Scope; scopeClientId: string },
  subjectId: number,
  permission: Permission,
  recipientPublicKey: B64 | null,
  keyring: ScopeKeyring,
): Promise<GrantDto> {
  const keys: unknown[] = [];

  if (permission !== 'none' && recipientPublicKey) {
    const scopeKey = keyring.get(target.scope.id, target.scope.version);
    if (!scopeKey) throw new Error('you do not hold the key for this folder');

    const box = await seal(
      splitPublicBlob(b64ToBytes(recipientPublicKey)).seal,
      await exportKey(scopeKey),
      sealInfo(target.scopeClientId, target.scope.version),
    );

    keys.push({
      scope_id: target.scope.id,
      key_version: target.scope.version,
      wrapped_key: bytesToB64(box.blob),
      nonce: bytesToB64(box.nonce),
    });
  }

  return api.put<GrantDto>(`/vaults/${vaultId}/grants`, {
    scope_type: target.scopeType,
    scope_ref_id: target.scopeRefId,
    subject_type: 'user',
    subject_id: subjectId,
    permission,
    key_grants: keys,
  });
}

export function deleteGrant(vaultId: number, grantId: number): Promise<void> {
  return api.delete<void>(`/vaults/${vaultId}/grants/${grantId}`);
}

export function listInvites(vaultId: number): Promise<{ invites: InviteDto[] }> {
  return api.get<{ invites: InviteDto[] }>(`/vaults/${vaultId}/invites`);
}

export function revokeInvite(vaultId: number, inviteId: number): Promise<void> {
  return api.delete<void>(`/vaults/${vaultId}/invites/${inviteId}`);
}

export interface CreatedInvite {
  invite: InviteDto;
  /** Shown once. The server holds only its digest and cannot reproduce it. */
  code: string;
}

/**
 * Opens a code invite. The scope keys are wrapped with a key derived from the code, so the
 * only thing that can open them is the code itself — which is handed to a person, not
 * uploaded.
 */
export async function createCodeInvite(
  vaultId: number,
  role: Role,
  preview: InvitePreview,
  scopes: Array<{ scope: Scope; scopeClientId: string }>,
  keyring: ScopeKeyring,
): Promise<CreatedInvite> {
  const code = generateInviteCode();
  const key = await inviteKey(code);

  const keys = [];

  for (const target of scopes) {
    const scopeKey = keyring.get(target.scope.id, target.scope.version);
    if (!scopeKey) continue;

    const wrapped = await wrapScopeKey(
      key,
      await exportKey(scopeKey),
      target.scopeClientId,
      target.scope.version,
    );

    keys.push({
      scope_id: target.scope.id,
      key_version: target.scope.version,
      wrapped_key: bytesToB64(wrapped.ciphertext),
      nonce: bytesToB64(wrapped.nonce),
      wrap_algorithm: INVITE_WRAP_ALGORITHM,
    });
  }

  if (keys.length === 0) throw new Error('you hold no key to share for this vault');

  const sealedPreview = await sealPreview(key, preview);

  const invite = await api.post<InviteDto>(`/vaults/${vaultId}/invites`, {
    token_hash: bytesToB64(await inviteToken(code)),
    role,
    wrapped_preview: bytesToB64(sealedPreview.ciphertext),
    preview_nonce: bytesToB64(sealedPreview.nonce),
    key_grants: keys,
  });

  return { invite, code };
}

export interface ResolvedInvite {
  challenge: ChallengeDto;
  preview: InvitePreview;
}

/**
 * Resolves a code without an account. Everything the server returns is ciphertext; the
 * vault name appears only once the code opens the preview here.
 */
export async function resolveInvite(code: string): Promise<ResolvedInvite | null> {
  const key = await inviteKey(code);

  const challenge = await api.post<ChallengeDto>(
    '/invites/lookup',
    { token_hash: bytesToB64(await inviteToken(code)) },
    { anonymous: true },
  );

  const preview = await openPreview(key, {
    ciphertext: b64ToBytes(challenge.wrapped_preview),
    nonce: b64ToBytes(challenge.preview_nonce),
  });

  return preview ? { challenge, preview } : null;
}

/**
 * Redeems an invite: every scope key is opened with the code and re-sealed to the caller's
 * own public key, so the invite's copies can be dropped and the code stops being a way in.
 */
export async function redeemInvite(
  code: string,
  challenge: ChallengeDto,
  identity: Identity,
): Promise<void> {
  const key = await inviteKey(code);
  const mine = splitPublicBlob(identity.publicBlob).seal;

  const keys = [];

  for (const grant of challenge.key_grants) {
    if (grant.wrap_algorithm !== INVITE_WRAP_ALGORITHM) continue;

    const scopeKey = await unwrapScopeKey(
      key,
      { ciphertext: b64ToBytes(grant.wrapped_key), nonce: b64ToBytes(grant.nonce) },
      grant.scope_client_id,
      grant.key_version,
    );

    const box = await seal(mine, scopeKey, sealInfo(grant.scope_client_id, grant.key_version));

    keys.push({
      scope_id: grant.scope_id,
      key_version: grant.key_version,
      wrapped_key: bytesToB64(box.blob),
      nonce: bytesToB64(box.nonce),
    });
  }

  if (keys.length === 0) throw new Error('this invite carries no key this client understands');

  await api.post<InviteDto>('/invites/redeem', {
    token_hash: bytesToB64(await inviteToken(code)),
    key_grants: keys,
  });
}
