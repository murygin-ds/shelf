/** Base64 as it arrives from the API: Go marshals []byte with the standard padded alphabet. */
export type B64 = string;

const B64_CHUNK = 0x8000;

export function bytesToB64(bytes: Uint8Array): B64 {
  let binary = '';

  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }

  return btoa(binary);
}

export function b64ToBytes(value: B64): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }

  return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(value: string): Uint8Array {
  return encoder.encode(value);
}

export function fromUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);

  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
}

/** Comparison that does not short-circuit, for values an attacker can probe. */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;

  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }

  return diff === 0;
}

export function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);

  return out;
}

export function readU32be(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false);
}

export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** Crockford's alphabet: no I, L, O or U, so a code read aloud survives the trip. */
const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32(bytes: Uint8Array, length?: number): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];

  return length === undefined ? out : out.slice(0, length);
}

export function group(value: string, size: number, separator = '-'): string {
  const chunks: string[] = [];

  for (let i = 0; i < value.length; i += size) {
    chunks.push(value.slice(i, i + size));
  }

  return chunks.join(separator);
}

/** Block the note bodies are padded to, so their ciphertext length stops being a fingerprint. */
export const PAD_BLOCK = 4096;

/**
 * Prefixes the payload with its length and pads the result to a block boundary.
 * Without this the server learns the size of every note it stores.
 */
export function pad(payload: Uint8Array, block = PAD_BLOCK): Uint8Array {
  const framed = concat(u32be(payload.length), payload);
  const padded = new Uint8Array(Math.ceil(framed.length / block) * block);
  padded.set(framed);

  return padded;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new Error('padded payload is truncated');

  const length = readU32be(padded);
  if (length > padded.length - 4) throw new Error('padded payload declares an impossible length');

  return padded.subarray(4, 4 + length);
}
