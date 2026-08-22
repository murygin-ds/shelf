import { exportKey } from '@/crypto/aead';
import { b64ToBytes, bytesToB64, type B64 } from '@/crypto/bytes';
import { sealInfo } from '@/crypto/envelope';
import { splitPublicBlob } from '@/crypto/identity';
import type { ScopeKeyring } from '@/crypto/keyring';
import { seal } from '@/crypto/sealedbox';

import { api } from './client';
import type { Vault } from './workspace';

/**
 * The connector: the one place where this vault's key is handed to the server.
 *
 * The two-step shape is not an accident of the API. A key cannot be sealed to a public key
 * that does not exist yet, so the server mints an identity first and receives the key
 * second — and between the two the connector is a member of the vault that can read nothing.
 */

/** Matches the algorithm the keyring accepts; a grant written under any other is ignored. */
const WRAP_ALGORITHM = 'ecdh-p256-hkdf-a256gcm';

export type ConnectorRole = 'editor' | 'viewer';

export interface ConnectorDto {
  vault_id: number;
  user_id: number;
  public_key: B64;
  fingerprint: string;
  role: ConnectorRole;
  key_state: string;
  ready: boolean;
  created_at: string;
}

export interface Connector {
  vaultId: number;
  userId: number;
  /** Compared out of band against what the server reported when it was created. */
  fingerprint: string;
  role: ConnectorRole;
  /** False between the two halves of enabling: a member with no key reads nothing. */
  ready: boolean;
  createdAt: string;
}

export interface Credential {
  id: number;
  kind: 'static' | 'access' | 'refresh';
  label: string;
  createdAt: string;
  lastUsedAt?: string;
  expiresAt: string;
}

interface CredentialDto {
  id: number;
  kind: Credential['kind'];
  label: string;
  created_at: string;
  last_used_at?: string;
  expires_at: string;
}

export interface IssuedCredential {
  /** Shown once. What the server keeps is a digest, so a lost one is replaced, not recovered. */
  secret: string;
  kind: string;
  label: string;
  expiresAt: string;
}

function open(dto: ConnectorDto): Connector {
  return {
    vaultId: dto.vault_id,
    userId: dto.user_id,
    fingerprint: dto.fingerprint,
    role: dto.role,
    ready: dto.ready,
    createdAt: dto.created_at,
  };
}

/** Reads the connector on a vault, or null when there is none. */
export async function connector(vaultId: number): Promise<Connector | null> {
  try {
    return open(await api.get<ConnectorDto>(`/vaults/${vaultId}/mcp`));
  } catch {
    // A vault with no connector answers 404, which is the ordinary case rather than a fault.
    return null;
  }
}

/**
 * Turns the connector on: mints its identity, then seals this vault's key to it.
 *
 * Only the vault's own scope is sealed. A folder given its own key stays unreadable to the
 * connector, and that is the point — it is how a person keeps one part of a connected vault
 * to themselves without a second mechanism for it.
 */
export async function enable(
  vault: Vault,
  role: ConnectorRole,
  keyring: ScopeKeyring,
): Promise<Connector> {
  const identity = await api.post<ConnectorDto>(`/vaults/${vault.id}/mcp/identity`, { role });

  const key = keyring.get(vault.keyScopeId, vault.keyVersion);
  if (!key) throw new Error('this vault is not unlocked, so its key cannot be handed over');

  const recipient = splitPublicBlob(b64ToBytes(identity.public_key)).seal;

  const box = await seal(
    recipient,
    await exportKey(key),
    sealInfo(vault.keyScopeClientId, vault.keyVersion),
  );

  return open(
    await api.post<ConnectorDto>(`/vaults/${vault.id}/mcp`, {
      keys: [
        {
          scope_id: vault.keyScopeId,
          key_version: vault.keyVersion,
          wrapped_key: bytesToB64(box.blob),
          nonce: bytesToB64(box.nonce),
          wrap_algorithm: WRAP_ALGORITHM,
        },
      ],
    }),
  );
}

/**
 * Removes the connector. The scopes it comes back with are the ones it could read: revoking
 * is immediate, but a key already copied stays good for ciphertext already seen, so rotating
 * these is what makes the removal retroactive.
 */
export async function disable(vaultId: number): Promise<number[]> {
  const { scopes_awaiting_rotation: scopes } = await api.delete<{
    scopes_awaiting_rotation: number[];
  }>(`/vaults/${vaultId}/mcp`);

  return scopes ?? [];
}

/** Mints a fixed credential for a client that carries it in a header. */
export async function issueCredential(vaultId: number, label: string): Promise<IssuedCredential> {
  const issued = await api.post<{
    secret: string;
    kind: string;
    label: string;
    expires_at: string;
  }>(`/vaults/${vaultId}/mcp/credentials`, { label });

  return {
    secret: issued.secret,
    kind: issued.kind,
    label: issued.label,
    expiresAt: issued.expires_at,
  };
}

export async function credentials(vaultId: number): Promise<Credential[]> {
  const { credentials: list } = await api.get<{ credentials: CredentialDto[] }>(
    `/vaults/${vaultId}/mcp/credentials`,
  );

  return (list ?? []).map((item) => ({
    id: item.id,
    kind: item.kind,
    label: item.label,
    createdAt: item.created_at,
    ...(item.last_used_at ? { lastUsedAt: item.last_used_at } : {}),
    expiresAt: item.expires_at,
  }));
}

/** Signs the connector out without taking its key away. */
export const revokeCredentials = (vaultId: number): Promise<void> =>
  api.delete<void>(`/vaults/${vaultId}/mcp/credentials`);

/** Records a person's consent to an OAuth client, and says where to send the browser next. */
export async function approve(input: {
  vaultId: number;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
}): Promise<string> {
  const { redirect_to: redirect } = await api.post<{ redirect_to: string }>('/oauth/authorize', {
    vault_id: input.vaultId,
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    code_challenge: input.codeChallenge,
    ...(input.state ? { state: input.state } : {}),
  });

  return redirect;
}
