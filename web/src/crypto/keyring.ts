import { importKey } from './aead';
import { b64ToBytes, type B64 } from './bytes';
import { sealInfo } from './envelope';
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

  static async fromGrants(grants: KeyGrantDto[], identity: Identity): Promise<ScopeKeyring> {
    const keyring = new ScopeKeyring();

    for (const grant of grants) {
      // Group grants are opened with the group's private key, which arrives with
      // membership rather than with the keyring.
      if (grant.subject_type !== 'user') continue;

      if (grant.wrap_algorithm !== SUPPORTED_ALGORITHM) continue;

      try {
        const raw = await open(
          identity.sealPrivate,
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
