import { argon2id } from 'hash-wasm';

import { importKey, KEY_LENGTH } from './aead';
import { randomBytes, utf8 } from './bytes';

export interface KdfParams {
  algorithm: 'argon2id';
  memory: number;
  iterations: number;
  parallelism: number;
}

/** Mirrors auth.DefaultKDFParams() on the server and satisfies the bounds its DTO enforces. */
export const DEFAULT_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memory: 65536,
  iterations: 3,
  parallelism: 2,
};

export const SALT_LENGTH = 16;

/** Half goes to the server as proof, half stays here as the key that unwraps the master key. */
const DERIVED_LENGTH = KEY_LENGTH * 2;

const RECOVERY_SALT_LABEL = 'shelf/recovery-salt/v1|';

export interface AccountKeys {
  /** Sent to the server, which stores only its Argon2id hash. */
  authHash: Uint8Array;
  /** Never leaves the device. Wraps and unwraps the master key. */
  wrappingKey: CryptoKey;
}

export function newSalt(): Uint8Array {
  return randomBytes(SALT_LENGTH);
}

/**
 * One Argon2id pass yields 64 bytes that are split in two. Two independent passes with
 * different salts would cost twice as much for no gain: the halves of a KDF output are
 * already independent.
 */
export async function deriveAccountKeys(
  passphrase: string,
  salt: Uint8Array,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<AccountKeys> {
  const derived = await argon2id({
    password: passphrase,
    salt,
    parallelism: params.parallelism,
    iterations: params.iterations,
    memorySize: params.memory,
    hashLength: DERIVED_LENGTH,
    outputType: 'binary',
  });

  return {
    authHash: derived.slice(0, KEY_LENGTH),
    wrappingKey: await importKey(derived.slice(KEY_LENGTH)),
  };
}

/**
 * The recovery code is derived the same way, but its salt has to be reproducible from the
 * login alone: recovery_keys stores no salt, and the user has nothing but the code and
 * their login at that point. A 125-bit code makes a deterministic salt harmless.
 */
export async function deriveRecoveryKeys(code: string, login: string): Promise<AccountKeys> {
  return deriveAccountKeys(normalizeRecoveryCode(code), await recoverySalt(login));
}

async function recoverySalt(login: string): Promise<Uint8Array> {
  const seed = utf8(RECOVERY_SALT_LABEL + login.trim().toLowerCase());

  return new Uint8Array(await crypto.subtle.digest('SHA-256', seed as BufferSource));
}

/** Accepts the code as printed on the kit, as pasted, or as typed without the dashes. */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase();
}
