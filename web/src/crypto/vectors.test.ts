import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { b64ToBytes, bytesToB64, pad } from './bytes';
import {
  aad,
  decryptContent,
  decryptMeta,
  type EntityMeta,
  type EntityRef,
  sealInfo,
} from './envelope';
import { CURVE, fingerprint, verify } from './identity';
import { open, type SealedBox } from './sealedbox';
import { revisionPayload } from './signature';

/**
 * The two halves of the pact with internal/envelope.
 *
 * crypto-vectors.json is what this implementation produces and what Go has to match;
 * crypto-vectors-go.json is what Go produces and this implementation has to open. Neither
 * side round-tripping with itself would catch the expensive failure, which is Go writing a
 * note the browser cannot read.
 *
 * Regenerate deliberately:
 *   cd web && npx vite-node scripts/gen-vectors.ts
 *   go test ./internal/envelope -update
 */
const read = (name: string): any =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../testdata/${name}`, import.meta.url)), 'utf8'));

const vectors = read('crypto-vectors.json');
const fromGo = read('crypto-vectors-go.json');

const refOf = (r: any): EntityRef => ({
  vaultId: r.vault_id,
  entity: r.entity,
  entityId: r.entity_id,
  scopeClientId: r.scope_client_id,
  keyVersion: r.key_version,
});

const key = async (raw: string): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', b64ToBytes(raw) as BufferSource, 'AES-GCM', true, [
    'encrypt',
    'decrypt',
  ]);

/** The agreement half of an identity bundle: format byte, then two length-prefixed PKCS#8 keys. */
async function sealPrivateOf(bundleB64: string): Promise<CryptoKey> {
  const bundle = b64ToBytes(bundleB64);
  const view = new DataView(bundle.buffer, bundle.byteOffset, bundle.byteLength);
  const length = view.getUint16(1, false);

  return crypto.subtle.importKey(
    'pkcs8',
    bundle.subarray(3, 3 + length) as BufferSource,
    { name: 'ECDH', namedCurve: CURVE },
    true,
    ['deriveBits'],
  );
}

describe('the vectors this implementation owns', () => {
  it('still builds the same additional data', () => {
    for (const c of vectors.aad) {
      expect(bytesToB64(aad(refOf(c.ref)))).toBe(c.expected_b64);
    }
  });

  it('still builds the same seal info', () => {
    for (const c of vectors.seal_info) {
      expect(sealInfo(c.scope_client_id, c.key_version)).toBe(c.expected);
    }
  });

  it('still pads to the same bytes', () => {
    for (const c of vectors.pad) {
      expect(bytesToB64(pad(b64ToBytes(c.input_b64)))).toBe(c.expected_b64);
    }
  });

  it('still serialises metadata the same way', () => {
    for (const c of vectors.meta_json) {
      expect(JSON.stringify(c.meta as EntityMeta)).toBe(c.expected);
    }
  });

  it('still derives the same fingerprint', async () => {
    for (const c of vectors.fingerprint) {
      await expect(fingerprint(b64ToBytes(c.public_blob_b64))).resolves.toBe(c.expected);
    }
  });
});

describe('what the connector sealed', () => {
  const sealed = (c: any): SealedBox => ({
    blob: b64ToBytes(c.blob_b64),
    nonce: b64ToBytes(c.nonce_b64),
  });

  it('opens metadata written by Go', async () => {
    const meta = await decryptMeta(
      await key(fromGo.key_b64),
      { ciphertext: b64ToBytes(fromGo.envelope_meta.ciphertext_b64), nonce: b64ToBytes(fromGo.envelope_meta.nonce_b64) },
      refOf(fromGo.ref),
    );

    expect(meta).toEqual(fromGo.envelope_meta.meta);
  });

  it('opens a body written by Go, padding and all', async () => {
    const body = await decryptContent(
      await key(fromGo.key_b64),
      { ciphertext: b64ToBytes(fromGo.envelope_content.ciphertext_b64), nonce: b64ToBytes(fromGo.envelope_content.nonce_b64) },
      refOf(fromGo.ref),
    );

    expect(body).toBe(fromGo.envelope_content.body);
  });

  it('opens a scope key Go sealed to an identity', async () => {
    const payload = await open(
      await sealPrivateOf(fromGo.sealed_box.recipient_bundle_b64),
      sealed(fromGo.sealed_box),
      fromGo.sealed_box.info,
    );

    expect(bytesToB64(payload)).toBe(fromGo.sealed_box.payload_b64);
  });

  it('derives the same fingerprint for a Go identity', async () => {
    await expect(fingerprint(b64ToBytes(fromGo.fingerprint.public_blob_b64))).resolves.toBe(
      fromGo.fingerprint.expected,
    );
  });

  it('accepts a revision signature made by Go', async () => {
    const signed = fromGo.revision_signature;

    const payload = revisionPayload(refOf(fromGo.ref), signed.content_seq, {
      ciphertext: b64ToBytes(signed.ciphertext_b64),
      nonce: b64ToBytes(signed.nonce_b64),
    });

    await expect(
      verify(b64ToBytes(signed.public_blob_b64), b64ToBytes(signed.signature_b64), payload),
    ).resolves.toBe(true);
  });

  it('rejects that signature at a sequence it was not made for', async () => {
    const signed = fromGo.revision_signature;

    const payload = revisionPayload(refOf(fromGo.ref), signed.content_seq + 1, {
      ciphertext: b64ToBytes(signed.ciphertext_b64),
      nonce: b64ToBytes(signed.nonce_b64),
    });

    await expect(
      verify(b64ToBytes(signed.public_blob_b64), b64ToBytes(signed.signature_b64), payload),
    ).resolves.toBe(false);
  });

  it('reports locked rather than throwing when the body is moved to another slot', async () => {
    const elsewhere = { ...refOf(fromGo.ref), entityId: '00000000-0000-4000-8000-000000000000' };

    const body = await decryptContent(
      await key(fromGo.key_b64),
      { ciphertext: b64ToBytes(fromGo.envelope_content.ciphertext_b64), nonce: b64ToBytes(fromGo.envelope_content.nonce_b64) },
      elsewhere,
    );

    expect(body).toEqual({ locked: true });
  });
});
