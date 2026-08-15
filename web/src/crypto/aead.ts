import { randomBytes } from './bytes';

export const NONCE_LENGTH = 12;
export const KEY_LENGTH = 32;

export interface Sealed {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

/**
 * AES-256-GCM through WebCrypto. It is the only symmetric primitive the browser offers
 * natively, and its 12-byte nonce fits the bounds the API already validates.
 */
export async function importKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== KEY_LENGTH) throw new Error(`content key must be ${KEY_LENGTH} bytes`);

  return crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

export async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

export async function exportKey(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

export async function encrypt(key: CryptoKey, plaintext: Uint8Array, aad: Uint8Array): Promise<Sealed> {
  const nonce = randomBytes(NONCE_LENGTH);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad as BufferSource },
    key,
    plaintext as BufferSource,
  );

  return { ciphertext: new Uint8Array(ciphertext), nonce };
}

/**
 * Fails on any tampering, including a ciphertext moved to a different slot: the caller's
 * additional data binds it to one entity, scope and key version.
 */
export async function decrypt(
  key: CryptoKey,
  sealed: Sealed,
  aad: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.nonce as BufferSource, additionalData: aad as BufferSource },
    key,
    sealed.ciphertext as BufferSource,
  );

  return new Uint8Array(plaintext);
}
