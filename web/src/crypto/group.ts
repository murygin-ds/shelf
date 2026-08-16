import { CURVE, type Identity, splitPublicBlob } from './identity';
import { open, seal, type SealedBox } from './sealedbox';

/**
 * A group's own agreement keypair.
 *
 * It exists so that adding somebody to a group costs one seal rather than one per folder
 * the group can reach. Without it, "add Marta to Design" would require the person doing it
 * to hold every content key the group touches — so an admin excluded from one folder could
 * not add anybody to a group that reaches it.
 *
 * A group has no signing key. It never writes, so there would be nothing to attribute.
 */
export interface GroupKeypair {
  publicKey: CryptoKey;
  privateKey: CryptoKey;
  /** The raw 65-byte point stored in groups.public_key. */
  publicRaw: Uint8Array;
}

/** Binds a sealed group key to the group and version it belongs to. */
function groupInfo(groupClientId: string, keyVersion: number): string {
  return `shelf/group/v1|${groupClientId}|${keyVersion}`;
}

export async function generateGroupKeypair(): Promise<GroupKeypair> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, [
    'deriveBits',
  ]);

  return {
    publicKey: pair.publicKey,
    privateKey: pair.privateKey,
    publicRaw: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)),
  };
}

/**
 * Seals the group's private key to one member. This is the whole cost of adding somebody,
 * whatever the group can reach.
 */
export async function sealGroupKey(
  keypair: GroupKeypair,
  memberPublicBlob: Uint8Array,
  groupClientId: string,
  keyVersion: number,
): Promise<SealedBox> {
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keypair.privateKey));

  return seal(splitPublicBlob(memberPublicBlob).seal, pkcs8, groupInfo(groupClientId, keyVersion));
}

/** Opens a member's own copy of the group's private key. */
export async function openGroupKey(
  identity: Identity,
  sealed: SealedBox,
  groupClientId: string,
  keyVersion: number,
): Promise<CryptoKey> {
  const pkcs8 = await open(identity.sealPrivate, sealed, groupInfo(groupClientId, keyVersion));

  return crypto.subtle.importKey('pkcs8', pkcs8 as BufferSource, { name: 'ECDH', namedCurve: CURVE }, true, [
    'deriveBits',
  ]);
}

/** Imports a group's public key from the raw point the server stores. */
export async function importGroupPublic(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDH', namedCurve: CURVE }, true, []);
}
