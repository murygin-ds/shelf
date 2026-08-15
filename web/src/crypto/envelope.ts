import { decrypt, encrypt, type Sealed } from './aead';
import { fromUtf8, pad, unpad, utf8 } from './bytes';

export type EntityType = 'vault' | 'folder' | 'file' | 'group' | 'revision';

/**
 * Identifies the exact slot a ciphertext belongs to.
 *
 * Both the entity and its key scope are named by client ids rather than serial ones: the
 * client picks them before the rows exist, which is what lets metadata be sealed with its
 * final additional data in a single round trip — and what lets a re-key encrypt under a
 * scope that the commit has not created yet.
 */
export interface EntityRef {
  vaultId: number;
  entity: EntityType;
  entityId: string;
  scopeClientId: string;
  keyVersion: number;
}

/**
 * Additional authenticated data. Without it a hostile server could move one note's
 * ciphertext onto another note in the same scope and the client would decrypt it happily:
 * confidentiality would hold, but placement would not.
 */
export function aad(ref: EntityRef): Uint8Array {
  return utf8(
    `shelf/v1|${ref.vaultId}|${ref.entity}|${ref.entityId}|${ref.scopeClientId}|${ref.keyVersion}`,
  );
}

/** The info string that binds a sealed scope key to the scope and version it unlocks. */
export function sealInfo(scopeClientId: string, keyVersion: number): string {
  return `shelf/seal/v1|${scopeClientId}|${keyVersion}`;
}

/**
 * Stands in for content the viewer holds no key to. Returning it instead of throwing is
 * what lets the tree render a greyed row and the graph a nameless node without a try/catch
 * around every read.
 */
export const LOCKED = Object.freeze({ locked: true as const });
export type Locked = typeof LOCKED;

export function isLocked(value: unknown): value is Locked {
  return value === LOCKED;
}

/** Everything a folder or a note carries besides its body. */
export interface EntityMeta {
  name: string;
  icon?: string;
}

export async function encryptMeta(key: CryptoKey, meta: EntityMeta, ref: EntityRef): Promise<Sealed> {
  return encrypt(key, utf8(JSON.stringify(meta)), aad(ref));
}

export async function decryptMeta(
  key: CryptoKey | undefined,
  sealed: Sealed,
  ref: EntityRef,
): Promise<EntityMeta | Locked> {
  if (!key) return LOCKED;

  try {
    return JSON.parse(fromUtf8(await decrypt(key, sealed, aad(ref)))) as EntityMeta;
  } catch {
    return LOCKED;
  }
}

export async function encryptContent(key: CryptoKey, body: string, ref: EntityRef): Promise<Sealed> {
  return encrypt(key, pad(utf8(body)), aad(ref));
}

export async function decryptContent(
  key: CryptoKey | undefined,
  sealed: Sealed,
  ref: EntityRef,
): Promise<string | Locked> {
  if (!key) return LOCKED;

  try {
    return fromUtf8(unpad(await decrypt(key, sealed, aad(ref))));
  } catch {
    return LOCKED;
  }
}
