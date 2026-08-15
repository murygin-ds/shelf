import { NONCE_LENGTH } from './aead';
import { concat, randomBytes, utf8 } from './bytes';
import { CURVE, importSealPublic, PUBLIC_KEY_LENGTH } from './identity';

/**
 * Anonymous public-key encryption: an ephemeral P-256 keypair agrees with the recipient's
 * agreement key, HKDF turns the shared secret into an AES-256-GCM key, and the ephemeral
 * public key rides along so the recipient can repeat the agreement.
 *
 * This is how every scope key reaches a member, a group or an invite.
 */
export const SEAL_FORMAT = 0x01;

export interface SealedBox {
  /** SEAL_FORMAT || ephemeral public key || ciphertext. Stored in a wrapped_key column. */
  blob: Uint8Array;
  nonce: Uint8Array;
}

export async function seal(
  recipientPublicRaw: Uint8Array,
  payload: Uint8Array,
  info: string,
): Promise<SealedBox> {
  const recipient = await importSealPublic(recipientPublicRaw);

  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, [
    'deriveBits',
  ]);

  const nonce = randomBytes(NONCE_LENGTH);
  const key = await agree(ephemeral.privateKey, recipient, nonce, info);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: utf8(info) as BufferSource },
    key,
    payload as BufferSource,
  );

  const ephemeralPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));

  return {
    blob: concat(Uint8Array.of(SEAL_FORMAT), ephemeralPublic, new Uint8Array(ciphertext)),
    nonce,
  };
}

export async function open(
  recipientPrivate: CryptoKey,
  box: SealedBox,
  info: string,
): Promise<Uint8Array> {
  const { blob, nonce } = box;

  if (blob[0] !== SEAL_FORMAT) throw new Error('unknown sealed box format');

  if (blob.length <= 1 + PUBLIC_KEY_LENGTH) throw new Error('sealed box is truncated');

  const ephemeralPublic = await importSealPublic(blob.subarray(1, 1 + PUBLIC_KEY_LENGTH));
  const key = await agree(recipientPrivate, ephemeralPublic, nonce, info);

  const payload = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: utf8(info) as BufferSource },
    key,
    blob.subarray(1 + PUBLIC_KEY_LENGTH) as BufferSource,
  );

  return new Uint8Array(payload);
}

// The ephemeral keypair already makes the agreed key unique per box, so reusing the nonce
// as the HKDF salt costs nothing and keeps the stored shape identical to every other blob.
async function agree(
  privateKey: CryptoKey,
  publicKey: CryptoKey,
  nonce: Uint8Array,
  info: string,
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);

  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);

  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: nonce as BufferSource, info: utf8(info) as BufferSource },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
