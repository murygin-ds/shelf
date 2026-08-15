import { describe, expect, it } from 'vitest';

import { decrypt, encrypt, exportKey, generateKey, importKey, NONCE_LENGTH } from './aead';
import { b64ToBytes, bytesToB64, concat, equal, pad, PAD_BLOCK, unpad, utf8 } from './bytes';
import {
  aad,
  decryptContent,
  decryptMeta,
  encryptContent,
  encryptMeta,
  type EntityRef,
  isLocked,
  sealInfo,
} from './envelope';
import {
  generateIdentity,
  generateMasterKey,
  PUBLIC_KEY_LENGTH,
  sign,
  splitPublicBlob,
  unwrapIdentity,
  unwrapMasterKey,
  verify,
  wrapMasterKey,
} from './identity';
import { deriveAccountKeys, deriveRecoveryKeys, newSalt, normalizeRecoveryCode } from './kdf';
import { generateRecoveryCode, isRecoveryCodeShaped, renderRecoveryKit } from './recovery';
import { open, seal } from './sealedbox';

// Argon2id at production parameters costs ~64 MiB and a few hundred ms per call.
const KDF_TIMEOUT = 30_000;
// Cheap parameters for the tests that only care about wiring, not about work factor.
const FAST_KDF = { algorithm: 'argon2id', memory: 19456, iterations: 2, parallelism: 1 } as const;

const REF: EntityRef = { vaultId: 1, entity: 'file', entityId: 42, scopeId: 7, keyVersion: 2 };

describe('bytes', () => {
  it('round-trips base64 in the padded alphabet Go emits', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);

    expect(b64ToBytes(bytesToB64(bytes))).toEqual(bytes);
  });

  it('matches known base64 encodings', () => {
    // encoding/json marshals []byte with base64.StdEncoding, padding included.
    expect(bytesToB64(utf8('hello'))).toBe('aGVsbG8=');
    expect(bytesToB64(Uint8Array.of(0xff, 0xfe))).toBe('//4=');
    expect(bytesToB64(new Uint8Array(0))).toBe('');
  });

  it('compares without short-circuiting', () => {
    expect(equal(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3))).toBe(true);
    expect(equal(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4))).toBe(false);
    expect(equal(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 3))).toBe(false);
  });

  it('pads bodies to a block boundary and back', () => {
    for (const size of [0, 1, 100, PAD_BLOCK - 5, PAD_BLOCK, PAD_BLOCK + 1]) {
      const payload = new Uint8Array(size).fill(7);
      const padded = pad(payload);

      expect(padded.length % PAD_BLOCK).toBe(0);
      expect(padded.length).toBeGreaterThanOrEqual(payload.length);
      expect(unpad(padded)).toEqual(payload);
    }
  });

  it('hides the body size behind the block', () => {
    // Two notes of very different length must produce the same ciphertext length.
    expect(pad(utf8('a')).length).toBe(pad(utf8('a'.repeat(2000))).length);
  });

  it('rejects a padded payload claiming an impossible length', () => {
    const corrupt = concat(Uint8Array.of(0xff, 0xff, 0xff, 0xff), new Uint8Array(16));

    expect(() => unpad(corrupt)).toThrow();
  });
});

describe('aead', () => {
  it('round-trips with matching additional data', async () => {
    const key = await generateKey();
    const sealed = await encrypt(key, utf8('secret'), aad(REF));

    expect(sealed.nonce.length).toBe(NONCE_LENGTH);
    expect(await decrypt(key, sealed, aad(REF))).toEqual(utf8('secret'));
  });

  it('refuses a ciphertext moved to another slot', async () => {
    const key = await generateKey();
    const sealed = await encrypt(key, utf8('secret'), aad(REF));

    // Same scope, same key, different note: exactly the swap a hostile server would try.
    await expect(decrypt(key, sealed, aad({ ...REF, entityId: 43 }))).rejects.toThrow();
    await expect(decrypt(key, sealed, aad({ ...REF, keyVersion: 3 }))).rejects.toThrow();
  });

  it('refuses a tampered ciphertext', async () => {
    const key = await generateKey();
    const sealed = await encrypt(key, utf8('secret'), aad(REF));
    sealed.ciphertext.set([(sealed.ciphertext[0] ?? 0) ^ 0xff], 0);

    await expect(decrypt(key, sealed, aad(REF))).rejects.toThrow();
  });

  it('exports a 32-byte key', async () => {
    const raw = await exportKey(await generateKey());

    expect(raw.length).toBe(32);
    expect(await exportKey(await importKey(raw))).toEqual(raw);
  });
});

describe('kdf', () => {
  it(
    'derives deterministically and splits into independent halves',
    async () => {
      const salt = newSalt();

      const first = await deriveAccountKeys('correct horse battery staple', salt, FAST_KDF);
      const again = await deriveAccountKeys('correct horse battery staple', salt, FAST_KDF);

      expect(first.authHash).toEqual(again.authHash);
      expect(first.authHash.length).toBe(32);

      // The half that stays on the device must never equal the half that is sent away.
      expect(equal(first.authHash, await exportKey(first.wrappingKey))).toBe(false);
      expect(await exportKey(first.wrappingKey)).toEqual(await exportKey(again.wrappingKey));
    },
    KDF_TIMEOUT,
  );

  it(
    'separates by salt and by passphrase',
    async () => {
      const salt = newSalt();

      const base = await deriveAccountKeys('passphrase', salt, FAST_KDF);
      const otherSalt = await deriveAccountKeys('passphrase', newSalt(), FAST_KDF);
      const otherPass = await deriveAccountKeys('passphras3', salt, FAST_KDF);

      expect(equal(base.authHash, otherSalt.authHash)).toBe(false);
      expect(equal(base.authHash, otherPass.authHash)).toBe(false);
    },
    KDF_TIMEOUT,
  );

  it(
    'derives the recovery key from the code and the login alone',
    async () => {
      // recovery_keys stores no salt, so the derivation has to be reproducible from what
      // the user can type at recovery time.
      const first = await deriveRecoveryKeys('ABCDE-FGHJK-MNPQR-STVWX-YZ012', 'ilya@acme.dev');
      const again = await deriveRecoveryKeys('abcdefghjkmnpqrstvwxyz012', ' Ilya@Acme.dev ');
      const elsewhere = await deriveRecoveryKeys('ABCDE-FGHJK-MNPQR-STVWX-YZ012', 'marta@acme.dev');

      expect(first.authHash).toEqual(again.authHash);
      expect(equal(first.authHash, elsewhere.authHash)).toBe(false);
    },
    KDF_TIMEOUT * 3,
  );

  it('normalizes however the code was typed', () => {
    expect(normalizeRecoveryCode(' abcde-fghjk ')).toBe('ABCDEFGHJK');
  });
});

describe('identity', () => {
  it('round-trips the master key and both keypairs', async () => {
    const masterKey = await generateMasterKey();
    const wrappingKey = await generateKey();

    const wrappedMaster = await wrapMasterKey(masterKey, wrappingKey);
    const unwrappedMaster = await unwrapMasterKey(wrappedMaster, wrappingKey);

    expect(await exportKey(unwrappedMaster)).toEqual(await exportKey(masterKey));

    const created = await generateIdentity(masterKey);
    const restored = await unwrapIdentity(
      created.publicBlob,
      { ciphertext: created.wrappedPrivateKey, nonce: created.privateKeyNonce },
      unwrappedMaster,
    );

    expect(restored.fingerprint).toBe(created.identity.fingerprint);
    expect(restored.publicBlob).toEqual(created.publicBlob);
  });

  it('will not unwrap an identity with the wrong master key', async () => {
    const created = await generateIdentity(await generateMasterKey());

    await expect(
      unwrapIdentity(
        created.publicBlob,
        { ciphertext: created.wrappedPrivateKey, nonce: created.privateKeyNonce },
        await generateMasterKey(),
      ),
    ).rejects.toThrow();
  });

  it('carries two distinct public keys in one blob', async () => {
    const created = await generateIdentity(await generateMasterKey());
    const { seal: agreement, sign: signing } = splitPublicBlob(created.publicBlob);

    expect(created.publicBlob.length).toBe(1 + PUBLIC_KEY_LENGTH * 2);
    expect(agreement.length).toBe(PUBLIC_KEY_LENGTH);
    // Reusing one EC key for both ECDH and ECDSA is the shortcut this blob exists to avoid.
    expect(equal(agreement, signing)).toBe(false);
  });

  it('signs content so a reader can tell who wrote it', async () => {
    const author = await generateIdentity(await generateMasterKey());
    const impostor = await generateIdentity(await generateMasterKey());
    const payload = utf8('ciphertext digest');

    const signature = await sign(author.identity, payload);

    expect(await verify(author.publicBlob, signature, payload)).toBe(true);
    expect(await verify(impostor.publicBlob, signature, payload)).toBe(false);
    expect(await verify(author.publicBlob, signature, utf8('other digest'))).toBe(false);
  });

  it('derives a stable, readable fingerprint', async () => {
    const created = await generateIdentity(await generateMasterKey());
    const other = await generateIdentity(await generateMasterKey());

    expect(created.identity.fingerprint).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}( [0-9A-HJKMNP-TV-Z]{4}){3}$/);
    expect(created.identity.fingerprint).not.toBe(other.identity.fingerprint);
  });
});

describe('sealed box', () => {
  it('reaches only the intended recipient', async () => {
    const recipient = await generateIdentity(await generateMasterKey());
    const stranger = await generateIdentity(await generateMasterKey());

    const scopeKey = await exportKey(await generateKey());
    const info = sealInfo(7, 2);

    const box = await seal(splitPublicBlob(recipient.publicBlob).seal, scopeKey, info);

    expect(await open(recipient.identity.sealPrivate, box, info)).toEqual(scopeKey);
    await expect(open(stranger.identity.sealPrivate, box, info)).rejects.toThrow();
  });

  it('binds the box to its scope and version', async () => {
    const recipient = await generateIdentity(await generateMasterKey());
    const scopeKey = await exportKey(await generateKey());

    const box = await seal(splitPublicBlob(recipient.publicBlob).seal, scopeKey, sealInfo(7, 2));

    // A grant replayed against another scope or an older version must not open.
    await expect(open(recipient.identity.sealPrivate, box, sealInfo(8, 2))).rejects.toThrow();
    await expect(open(recipient.identity.sealPrivate, box, sealInfo(7, 1))).rejects.toThrow();
  });

  it('rejects a truncated or reformatted box', async () => {
    const recipient = await generateIdentity(await generateMasterKey());
    const info = sealInfo(7, 2);
    const box = await seal(splitPublicBlob(recipient.publicBlob).seal, new Uint8Array(32), info);

    await expect(
      open(recipient.identity.sealPrivate, { ...box, blob: box.blob.subarray(0, 40) }, info),
    ).rejects.toThrow();

    const reformatted = box.blob.slice();
    reformatted[0] = 0x02;

    await expect(
      open(recipient.identity.sealPrivate, { ...box, blob: reformatted }, info),
    ).rejects.toThrow();
  });
});

describe('envelope', () => {
  it('round-trips metadata and content', async () => {
    const key = await generateKey();

    const meta = await encryptMeta(key, { name: 'Access model v2', icon: '#i-shield' }, REF);
    expect(await decryptMeta(key, meta, REF)).toEqual({ name: 'Access model v2', icon: '#i-shield' });

    const body = '# Resolution order\n\nVault role sets the floor.';
    const content = await encryptContent(key, body, REF);
    expect(await decryptContent(key, content, REF)).toBe(body);
  });

  it('reports locked instead of throwing when the key is missing', async () => {
    const key = await generateKey();
    const meta = await encryptMeta(key, { name: 'Restricted' }, REF);
    const content = await encryptContent(key, 'secret', REF);

    // No key at all: what a member without a grant sees.
    expect(isLocked(await decryptMeta(undefined, meta, REF))).toBe(true);
    expect(isLocked(await decryptContent(undefined, content, REF))).toBe(true);

    // A key that does not fit, and a key that fits the wrong slot.
    expect(isLocked(await decryptMeta(await generateKey(), meta, REF))).toBe(true);
    expect(isLocked(await decryptMeta(key, meta, { ...REF, entityId: 43 }))).toBe(true);
  });

  it('keeps the body size out of the ciphertext length', async () => {
    const key = await generateKey();

    const short = await encryptContent(key, 'a', REF);
    const long = await encryptContent(key, 'a'.repeat(3000), REF);

    expect(short.ciphertext.length).toBe(long.ciphertext.length);
  });
});

describe('recovery kit', () => {
  it('generates a code of the documented shape', () => {
    const code = generateRecoveryCode();

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
    expect(isRecoveryCodeShaped(code)).toBe(true);
    expect(isRecoveryCodeShaped('too-short')).toBe(false);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('renders a kit that carries the code and the fingerprint', () => {
    const text = renderRecoveryKit({
      login: 'ilya@acme.dev',
      displayName: 'Ilya Volkov',
      code: 'ABCDE-FGHJK-MNPQR-STVWX-YZ012',
      fingerprint: 'A1B2 C3D4 E5F6 G7H8',
      issuedAt: new Date('2026-08-16T00:00:00Z'),
      origin: 'notes.acme.dev',
    });

    expect(text).toContain('ABCDE-FGHJK-MNPQR-STVWX-YZ012');
    expect(text).toContain('A1B2 C3D4 E5F6 G7H8');
    expect(text).toContain('ilya@acme.dev');
  });
});

describe('wire format bounds', () => {
  it('produces values the API DTO accepts', async () => {
    // internal/api/v1/auth/dto.go bounds every one of these, and a format change here
    // would only surface as a 422 in production.
    const masterKey = await generateMasterKey();
    const wrappingKey = await generateKey();

    const wrappedMaster = await wrapMasterKey(masterKey, wrappingKey);
    const identity = await generateIdentity(masterKey);

    const within = (value: Uint8Array, min: number, max: number) =>
      value.length >= min && value.length <= max;

    expect(within(identity.publicBlob, 32, 1024)).toBe(true);
    expect(within(identity.wrappedPrivateKey, 32, 1024)).toBe(true);
    expect(within(identity.privateKeyNonce, 12, 32)).toBe(true);
    expect(within(wrappedMaster.ciphertext, 32, 1024)).toBe(true);
    expect(within(wrappedMaster.nonce, 12, 32)).toBe(true);
    expect(within(newSalt(), 16, 64)).toBe(true);
    expect(within(new Uint8Array(32), 16, 128)).toBe(true);
  });
});
