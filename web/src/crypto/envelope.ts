import { decrypt, encrypt, type Sealed } from './aead';
import { fromUtf8, pad, PAD_UPDATE_BLOCK, unpad, utf8 } from './bytes';

export type EntityType = 'vault' | 'folder' | 'file' | 'group' | 'revision' | 'crdt' | 'presence';

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

/**
 * Additional data for one live-editing update.
 *
 * It is `aad` with the epoch added, and the epoch is what makes it a different slot: an
 * update carried into another epoch would merge into text it was never written against.
 * A separate function rather than a parameter on `aad`, because every ciphertext already
 * written is bound to that exact string and changing it would make all of it unreadable.
 */
export function crdtAad(ref: EntityRef, epoch: number): Uint8Array {
  return utf8(
    `shelf/crdt/v1|${ref.vaultId}|${ref.entityId}|${ref.scopeClientId}|${ref.keyVersion}|${epoch}`,
  );
}

/**
 * Additional data for a caret position. No epoch: awareness describes where somebody is
 * right now and is replaced several times a second, so binding it to a document version
 * would only make it expire faster than it is rewritten.
 */
export function presenceAad(ref: EntityRef): Uint8Array {
  return utf8(
    `shelf/presence/v1|${ref.vaultId}|${ref.entityId}|${ref.scopeClientId}|${ref.keyVersion}`,
  );
}

/** The info string that binds a sealed scope key to the scope and version it unlocks. */
export function sealInfo(scopeClientId: string, keyVersion: number): string {
  return `shelf/seal/v1|${scopeClientId}|${keyVersion}`;
}

/**
 * Binds a member's private label to the vault it annotates. Without it the server could
 * move one label onto another vault and the note would open, pointing at the wrong thing.
 */
export function labelInfo(vaultClientId: string): string {
  return `shelf/label/v1|${vaultClientId}`;
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
  /**
   * Tags chosen for the note, as opposed to the `#tag` written into its body. Optional, so
   * a note saved before this existed still opens — and so a note with none is sealed to the
   * same bytes it was before.
   */
  tags?: string[];
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

/**
 * Seals one live-editing update.
 *
 * Padded to a far smaller block than a body: an update is a few bytes of a keystroke, and
 * rounding each one up to 4 KiB would multiply the traffic of a typing session by two
 * hundred. What that leaves visible is the rhythm and rough volume of somebody's typing,
 * which is inherent to relaying edits as they happen and is documented rather than denied.
 */
export async function encryptUpdate(
  key: CryptoKey,
  update: Uint8Array,
  ref: EntityRef,
  epoch: number,
): Promise<Sealed> {
  return encrypt(key, pad(update, PAD_UPDATE_BLOCK), crdtAad(ref, epoch));
}

export async function decryptUpdate(
  key: CryptoKey | undefined,
  sealed: Sealed,
  ref: EntityRef,
  epoch: number,
): Promise<Uint8Array | Locked> {
  if (!key) return LOCKED;

  try {
    return unpad(await decrypt(key, sealed, crdtAad(ref, epoch)));
  } catch {
    return LOCKED;
  }
}

/** Seals a caret position. Same padding as an update, and for the same reason. */
export async function encryptPresence(
  key: CryptoKey,
  state: Uint8Array,
  ref: EntityRef,
): Promise<Sealed> {
  return encrypt(key, pad(state, PAD_UPDATE_BLOCK), presenceAad(ref));
}

export async function decryptPresence(
  key: CryptoKey | undefined,
  sealed: Sealed,
  ref: EntityRef,
): Promise<Uint8Array | Locked> {
  if (!key) return LOCKED;

  try {
    return unpad(await decrypt(key, sealed, presenceAad(ref)));
  } catch {
    return LOCKED;
  }
}
