import { importKey } from './aead';
import { b64ToBytes, type B64 } from './bytes';
import { sealInfo } from './envelope';
import { openGroupKey } from './group';
import type { Identity } from './identity';
import { open } from './sealedbox';

export interface KeyGrantDto {
  scope_id: number;
  /** Names the scope inside the sealed box, so a grant cannot be replayed elsewhere. */
  scope_client_id: string;
  key_version: number;
  subject_type: 'user' | 'group' | 'invite' | 'share_link';
  subject_id: number;
  wrapped_key: B64;
  nonce: B64;
  wrap_algorithm: string;
}

/** The caller's own copy of a group's private key, as the server returns it. */
export interface GroupKeyDto {
  group_id: number;
  group_client_id: string;
  key_version: number;
  wrapped_key: B64;
  nonce: B64;
}

const SUPPORTED_ALGORITHM = 'ecdh-p256-hkdf-a256gcm';

/**
 * Every content key the viewer can open, indexed by scope and version.
 *
 * Old versions are kept rather than replaced: revisions and trashed items stay encrypted
 * under whatever version was current when they were written, so dropping them would make
 * history unreadable after the first key rotation.
 *
 * A missing key is the normal case, not an error — it is exactly what a node the viewer
 * has no access to looks like.
 */
export class ScopeKeyring {
  private readonly keys = new Map<string, CryptoKey>();
  private readonly scopes = new Set<number>();

  /**
   * Builds the keyring from what the server hands back.
   *
   * A scope key sealed to a group is opened with the group's private key rather than the
   * reader's own — which is the point of a group: one seal per scope, not one per member.
   * Those private keys arrive separately, each sealed to the reader, so a group they do
   * not belong to yields nothing.
   */
  static async fromGrants(
    grants: KeyGrantDto[],
    identity: Identity,
    groupKeys: GroupKeyDto[] = [],
  ): Promise<ScopeKeyring> {
    const keyring = new ScopeKeyring();
    const groups = new Map<number, CryptoKey>();

    for (const key of groupKeys) {
      try {
        groups.set(
          key.group_id,
          await openGroupKey(
            identity,
            { blob: b64ToBytes(key.wrapped_key), nonce: b64ToBytes(key.nonce) },
            key.group_client_id,
            key.key_version,
          ),
        );
      } catch {
        // A copy this device cannot open belongs to an older version of the group, or to
        // a format this client no longer speaks. Neither should cost the whole vault.
      }
    }

    for (const grant of grants) {
      if (grant.wrap_algorithm !== SUPPORTED_ALGORITHM) continue;

      const opener =
        grant.subject_type === 'user'
          ? identity.sealPrivate
          : grant.subject_type === 'group'
            ? groups.get(grant.subject_id)
            : undefined;

      if (!opener) continue;

      try {
        const raw = await open(
          opener,
          { blob: b64ToBytes(grant.wrapped_key), nonce: b64ToBytes(grant.nonce) },
          sealInfo(grant.scope_client_id, grant.key_version),
        );

        keyring.add(grant.scope_id, grant.key_version, await importKey(raw));
      } catch {
        // A grant that will not open is a grant for somebody else, or one written by a
        // client that has since changed format. Neither is worth failing the whole vault.
      }
    }

    return keyring;
  }

  add(scopeId: number, version: number, key: CryptoKey): void {
    this.keys.set(ScopeKeyring.at(scopeId, version), key);
    this.scopes.add(scopeId);
  }

  get(scopeId: number, version: number): CryptoKey | undefined {
    return this.keys.get(ScopeKeyring.at(scopeId, version));
  }

  /** Drives which drop targets the tree offers: a scope with no key cannot receive a move. */
  has(scopeId: number): boolean {
    return this.scopes.has(scopeId);
  }

  get size(): number {
    return this.keys.size;
  }

  private static at(scopeId: number, version: number): string {
    return `${scopeId}:${version}`;
  }
}
