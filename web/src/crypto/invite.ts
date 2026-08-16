import { decrypt, encrypt, importKey, type Sealed } from './aead';
import { base32, fromUtf8, group, randomBytes, utf8 } from './bytes';
import { sealInfo } from './envelope';

/**
 * An invite code is a secret the server never sees. Two independent labelled digests come
 * out of it: one the server stores to find the invite, one that unwraps the scope keys
 * sealed to it. Neither can be derived from the other without the code itself.
 *
 * The code carries 125 bits, so it needs no password hashing — an attacker who could try
 * every value would already have won against any KDF.
 */
const CODE_BYTES = 16;
const CODE_CHARS = 25;
const CODE_GROUP = 5;

const TOKEN_LABEL = 'shelf/invite-token/v1|';
const KEY_LABEL = 'shelf/invite-key/v1|';
const PREVIEW_AAD = utf8('shelf/invite-preview/v1');

/** The wrapping format an invite's scope keys use: symmetric, because nobody knows yet
 *  whose public key to seal them to. */
export const INVITE_WRAP_ALGORITHM = 'aesgcm-invite-v1';

export function generateInviteCode(): string {
  return group(base32(randomBytes(CODE_BYTES), CODE_CHARS), CODE_GROUP);
}

export function normalizeInviteCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}

export function isInviteCodeShaped(code: string): boolean {
  return normalizeInviteCode(code).length === CODE_CHARS;
}

/** What the server stores to find the invite. It reveals nothing about the code. */
export async function inviteToken(code: string): Promise<Uint8Array> {
  return digest(TOKEN_LABEL + normalizeInviteCode(code));
}

/** The key that unwraps everything sealed to this invite. It never leaves the device. */
export async function inviteKey(code: string): Promise<CryptoKey> {
  return importKey(await digest(KEY_LABEL + normalizeInviteCode(code)));
}

async function digest(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(input) as BufferSource));
}

export interface InvitePreview {
  vaultName: string;
  inviterName: string;
  role: string;
  folders: string[];
}

export async function sealPreview(key: CryptoKey, preview: InvitePreview): Promise<Sealed> {
  return encrypt(key, utf8(JSON.stringify(preview)), PREVIEW_AAD);
}

export async function openPreview(key: CryptoKey, sealed: Sealed): Promise<InvitePreview | null> {
  try {
    return JSON.parse(fromUtf8(await decrypt(key, sealed, PREVIEW_AAD))) as InvitePreview;
  } catch {
    // A preview that will not open means the code is wrong, which is indistinguishable
    // from an invite that never existed — and deliberately so.
    return null;
  }
}

/** Wraps one scope key for the invite, bound to the scope it unlocks. */
export async function wrapScopeKey(
  key: CryptoKey,
  scopeKey: Uint8Array,
  scopeClientId: string,
  keyVersion: number,
): Promise<Sealed> {
  return encrypt(key, scopeKey, utf8(sealInfo(scopeClientId, keyVersion)));
}

export async function unwrapScopeKey(
  key: CryptoKey,
  sealed: Sealed,
  scopeClientId: string,
  keyVersion: number,
): Promise<Uint8Array> {
  return decrypt(key, sealed, utf8(sealInfo(scopeClientId, keyVersion)));
}
