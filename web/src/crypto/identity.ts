import { decrypt, encrypt, exportKey, generateKey, importKey, type Sealed } from './aead';
import { base32, concat, group, utf8 } from './bytes';

/**
 * A member holds two P-256 keypairs: one for key agreement, one for signatures.
 * WebCrypto binds a key to a single algorithm, and reusing one EC key across ECDH and
 * ECDSA is exactly the kind of shortcut that turns into a break later.
 *
 * Both public keys travel in the single public_key column as one versioned blob, and
 * both private keys travel in wrapped_private_key, encrypted with the master key.
 */
export const IDENTITY_FORMAT = 0x01;

export const CURVE = 'P-256';
/** Uncompressed P-256 point: 0x04 || x || y. */
export const PUBLIC_KEY_LENGTH = 65;

const MASTER_KEY_AAD = utf8('shelf/master-key/v1');
const IDENTITY_AAD = utf8('shelf/identity/v1');

const FINGERPRINT_CHARS = 16;
const FINGERPRINT_GROUP = 4;

export interface Identity {
  /** Agreement keys: seal to `sealPublic`, open with `sealPrivate`. */
  sealPublic: CryptoKey;
  sealPrivate: CryptoKey;
  signPrivate: CryptoKey;
  signPublic: CryptoKey;
  /** The exact bytes stored in users.public_key, needed to re-derive the fingerprint. */
  publicBlob: Uint8Array;
  fingerprint: string;
}

export interface NewIdentity {
  identity: Identity;
  publicBlob: Uint8Array;
  wrappedPrivateKey: Uint8Array;
  privateKeyNonce: Uint8Array;
}

export async function generateMasterKey(): Promise<CryptoKey> {
  return generateKey();
}

/** Wraps the master key with the key derived from a passphrase or a recovery code. */
export async function wrapMasterKey(masterKey: CryptoKey, wrappingKey: CryptoKey): Promise<Sealed> {
  return encrypt(wrappingKey, await exportKey(masterKey), MASTER_KEY_AAD);
}

export async function unwrapMasterKey(sealed: Sealed, wrappingKey: CryptoKey): Promise<CryptoKey> {
  return importKey(await decrypt(wrappingKey, sealed, MASTER_KEY_AAD));
}

export async function generateIdentity(masterKey: CryptoKey): Promise<NewIdentity> {
  const seal = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: CURVE }, true, [
    'deriveBits',
  ]);
  const sign = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: CURVE }, true, [
    'sign',
    'verify',
  ]);

  const sealPublicRaw = await rawPublic(seal.publicKey);
  const signPublicRaw = await rawPublic(sign.publicKey);
  const publicBlob = concat(Uint8Array.of(IDENTITY_FORMAT), sealPublicRaw, signPublicRaw);

  const bundle = concat(
    Uint8Array.of(IDENTITY_FORMAT),
    lengthPrefixed(new Uint8Array(await crypto.subtle.exportKey('pkcs8', seal.privateKey))),
    lengthPrefixed(new Uint8Array(await crypto.subtle.exportKey('pkcs8', sign.privateKey))),
  );

  const wrapped = await encrypt(masterKey, bundle, IDENTITY_AAD);

  return {
    identity: {
      sealPublic: seal.publicKey,
      sealPrivate: seal.privateKey,
      signPrivate: sign.privateKey,
      signPublic: sign.publicKey,
      publicBlob,
      fingerprint: await fingerprint(publicBlob),
    },
    publicBlob,
    wrappedPrivateKey: wrapped.ciphertext,
    privateKeyNonce: wrapped.nonce,
  };
}

export async function unwrapIdentity(
  publicBlob: Uint8Array,
  sealed: Sealed,
  masterKey: CryptoKey,
): Promise<Identity> {
  const { seal: sealPublicRaw, sign: signPublicRaw } = splitPublicBlob(publicBlob);
  const bundle = await decrypt(masterKey, sealed, IDENTITY_AAD);

  if (bundle[0] !== IDENTITY_FORMAT) throw new Error('unknown identity format');

  const sealPkcs8 = readLengthPrefixed(bundle, 1);
  const signPkcs8 = readLengthPrefixed(bundle, sealPkcs8.next);

  return {
    sealPublic: await importSealPublic(sealPublicRaw),
    sealPrivate: await crypto.subtle.importKey(
      'pkcs8',
      sealPkcs8.value as BufferSource,
      { name: 'ECDH', namedCurve: CURVE },
      true,
      ['deriveBits'],
    ),
    signPublic: await crypto.subtle.importKey(
      'raw',
      signPublicRaw as BufferSource,
      { name: 'ECDSA', namedCurve: CURVE },
      true,
      ['verify'],
    ),
    signPrivate: await crypto.subtle.importKey(
      'pkcs8',
      signPkcs8.value as BufferSource,
      { name: 'ECDSA', namedCurve: CURVE },
      true,
      ['sign'],
    ),
    publicBlob,
    fingerprint: await fingerprint(publicBlob),
  };
}

/** importKey rejects points off the curve, which closes the invalid-curve attack on P-256. */
export async function importSealPublic(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw as BufferSource, { name: 'ECDH', namedCurve: CURVE }, true, []);
}

export function splitPublicBlob(blob: Uint8Array): { seal: Uint8Array; sign: Uint8Array } {
  if (blob[0] !== IDENTITY_FORMAT) throw new Error('unknown public key format');

  if (blob.length !== 1 + PUBLIC_KEY_LENGTH * 2) {
    throw new Error('public key blob has an unexpected length');
  }

  return {
    seal: blob.subarray(1, 1 + PUBLIC_KEY_LENGTH),
    sign: blob.subarray(1 + PUBLIC_KEY_LENGTH),
  };
}

export async function sign(identity: Identity, payload: Uint8Array): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    identity.signPrivate,
    payload as BufferSource,
  );

  return new Uint8Array(signature);
}

export async function verify(
  authorPublicBlob: Uint8Array,
  signature: Uint8Array,
  payload: Uint8Array,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    'raw',
    splitPublicBlob(authorPublicBlob).sign as BufferSource,
    { name: 'ECDSA', namedCurve: CURVE },
    true,
    ['verify'],
  );

  return crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    signature as BufferSource,
    payload as BufferSource,
  );
}

/**
 * Short, readable digest of the public blob. The server hands out public keys, so it can
 * hand out its own; comparing fingerprints out of band is what closes that gap.
 */
export async function fingerprint(publicBlob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', publicBlob as BufferSource));

  return group(base32(digest, FINGERPRINT_CHARS), FINGERPRINT_GROUP, ' ');
}

async function rawPublic(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey('raw', key));
}

function lengthPrefixed(value: Uint8Array): Uint8Array {
  const header = new Uint8Array(2);
  new DataView(header.buffer).setUint16(0, value.length, false);

  return concat(header, value);
}

function readLengthPrefixed(bundle: Uint8Array, offset: number): { value: Uint8Array; next: number } {
  if (offset + 2 > bundle.length) throw new Error('identity bundle is truncated');

  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const length = view.getUint16(offset, false);
  const start = offset + 2;

  if (start + length > bundle.length) throw new Error('identity bundle is truncated');

  return { value: bundle.subarray(start, start + length), next: start + length };
}
