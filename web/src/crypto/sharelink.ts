import { decrypt, encrypt, importKey, type Sealed } from './aead';
import { base32, randomBytes, utf8 } from './bytes';

/**
 * A public link is a secret the server never sees, exactly like an invite code.
 *
 * Two independent labelled digests come out of it: one the server stores to find the link,
 * one that unwraps the note's key. Neither can be derived from the other without the
 * secret, and the secret lives in the URL fragment — which browsers do not send.
 *
 * 160 bits, because unlike an invite code nobody types this by hand, and a public link is
 * the one credential that may be pasted into a chat and live for months.
 */
const SECRET_BYTES = 20;
const SECRET_CHARS = 32;

const TOKEN_LABEL = 'shelf/share-token/v1|';
const KEY_LABEL = 'shelf/share-key/v1|';

/**
 * Binds the published copy to the note it claims to be, so one link's ciphertext cannot be
 * served under another link's secret.
 */
export function shareAAD(noteClientId: string): Uint8Array {
  return utf8(`shelf/share/v1|${noteClientId}`);
}

export function generateShareSecret(): string {
  return base32(randomBytes(SECRET_BYTES), SECRET_CHARS);
}

export function normalizeShareSecret(secret: string): string {
  return secret.replace(/[\s-]/g, '').toUpperCase();
}

export function isShareSecretShaped(secret: string): boolean {
  return normalizeShareSecret(secret).length === SECRET_CHARS;
}

/** What the server stores to find the link. It reveals nothing about the secret. */
export async function shareToken(secret: string): Promise<Uint8Array> {
  return digest(TOKEN_LABEL + normalizeShareSecret(secret));
}

/** The key that unwraps the note key. It never leaves the visitor's browser. */
export async function shareKey(secret: string): Promise<CryptoKey> {
  return importKey(await digest(KEY_LABEL + normalizeShareSecret(secret)));
}

/** Seals one field of the published copy under the link key. */
export async function sealForLink(
  linkKey: CryptoKey,
  plaintext: Uint8Array,
  noteClientId: string,
): Promise<Sealed> {
  return encrypt(linkKey, plaintext, shareAAD(noteClientId));
}

export async function openFromLink(
  linkKey: CryptoKey,
  sealed: Sealed,
  noteClientId: string,
): Promise<Uint8Array> {
  return decrypt(linkKey, sealed, shareAAD(noteClientId));
}

async function digest(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(input) as BufferSource));
}
