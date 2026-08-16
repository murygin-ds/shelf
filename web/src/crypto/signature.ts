import { concat, utf8 } from './bytes';
import type { EntityRef } from './envelope';
import { type Identity, sign, verify } from './identity';

/** Raw ECDSA P-256, r||s. WebCrypto produces exactly this; DER would be the other form. */
export const SIGNATURE_LENGTH = 64;

/**
 * What an author signs.
 *
 * The ciphertext alone is not enough. Signing it bare would let the server move a signed
 * body onto a different note, or replay an old one as the current version, and the
 * signature would still check out. So the digest covers the slot as well: which vault,
 * which note, under which scope and version, at which sequence.
 *
 * The nonce is in there too — without it, two versions with identical plaintext would
 * produce the same digest and one signature would cover both.
 */
export function revisionPayload(ref: EntityRef, contentSeq: number, sealed: {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}): Uint8Array {
  const header = utf8(
    `shelf/sig/v1|${ref.vaultId}|${ref.entityId}|${ref.scopeClientId}|${ref.keyVersion}|${contentSeq}|`,
  );

  return concat(header, sealed.nonce, sealed.ciphertext);
}

/**
 * Signs a body. It is what makes "written by" a fact rather than a claim: view, comment
 * and edit are one key, so any reader could otherwise produce ciphertext that decrypts and
 * no reader could tell the difference.
 */
export async function signRevision(
  identity: Identity,
  ref: EntityRef,
  contentSeq: number,
  sealed: { ciphertext: Uint8Array; nonce: Uint8Array },
): Promise<Uint8Array> {
  return sign(identity, revisionPayload(ref, contentSeq, sealed));
}

/** How a stored revision's authorship checks out, or fails to. */
export type Authorship = 'valid' | 'invalid' | 'unsigned' | 'unknown-author';

/**
 * Checks who wrote a revision.
 *
 * `unsigned` is not the same as `invalid`: a body written before signatures existed simply
 * carries none, and calling that forged would be a lie. It is not proof of authorship
 * either, and the view says so rather than showing a name.
 */
export async function checkAuthorship(
  authorPublicBlob: Uint8Array | null,
  signature: Uint8Array | null,
  ref: EntityRef,
  contentSeq: number,
  sealed: { ciphertext: Uint8Array; nonce: Uint8Array },
): Promise<Authorship> {
  if (!signature || signature.length !== SIGNATURE_LENGTH) return 'unsigned';
  if (!authorPublicBlob || authorPublicBlob.length === 0) return 'unknown-author';

  try {
    const ok = await verify(authorPublicBlob, signature, revisionPayload(ref, contentSeq, sealed));

    return ok ? 'valid' : 'invalid';
  } catch {
    // A public key that will not import is not a failed check — it is an author this
    // client cannot make sense of, and saying "forged" would be the wrong accusation.
    return 'unknown-author';
  }
}
