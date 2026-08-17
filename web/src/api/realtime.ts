/**
 * The frames the live editing socket speaks, and the conversion between the base64 the
 * wire carries and the bytes the CRDT works in.
 *
 * Every payload here is ciphertext. The server relays it, counts it and refuses it when
 * the sender may not write — it never opens one.
 */

import { b64ToBytes, bytesToB64, type B64 } from '@/crypto/bytes';

export const FRAME = {
  auth: 'auth',
  subscribe: 'subscribe',
  open: 'open',
  seed: 'seed',
  update: 'update',
  awareness: 'awareness',
  close: 'close',

  ready: 'ready',
  subscribed: 'subscribed',
  changed: 'changed',
  doc: 'doc',
  absent: 'absent',
  presence: 'presence',
  ack: 'ack',
  reseed: 'reseed',
  error: 'error',
} as const;

/** One stored update as it arrives. */
export interface WireUpdate {
  seq: number;
  payload: B64;
  nonce: B64;
  author_id?: number;
  signature?: B64;
}

export interface PeerDto {
  user_id: number;
  login: string;
  display_name: string;
  permission: string;
  /** The one connection that writes the body back. Chosen by the server, not by election. */
  committer?: boolean;
}

/** Everything the server may say. Fields are optional because one shape covers them all. */
export interface ServerFrame {
  type: string;
  user_id?: number;
  vault_id?: number;
  change_seq?: number;
  file_id?: number;
  epoch?: number;
  committed_seq?: number;
  last_seq?: number;
  snapshot_seq?: number;
  snapshot?: B64;
  nonce?: B64;
  key_scope_id?: number;
  key_version?: number;
  updates?: WireUpdate[];
  seq?: number;
  payload?: B64;
  signature?: B64;
  peers?: PeerDto[];
  /** Whether this socket is the one writing the body back. Per connection, not per person. */
  committing?: boolean;
  code?: string;
  message?: string;
}

/** A sealed blob on its way in or out. */
export interface SealedWire {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
}

export function openSealed(payload: B64 | undefined, nonce: B64 | undefined): SealedWire | null {
  if (!payload || !nonce) return null;

  try {
    return { ciphertext: b64ToBytes(payload), nonce: b64ToBytes(nonce) };
  } catch {
    // A frame this client cannot decode is a frame from a server it does not understand;
    // dropping it degrades to polling rather than breaking the session.
    return null;
  }
}

export function openUpdate(update: WireUpdate): SealedWire | null {
  return openSealed(update.payload, update.nonce);
}

export function openSignature(signature: B64 | undefined): Uint8Array | null {
  if (!signature) return null;

  try {
    return b64ToBytes(signature);
  } catch {
    return null;
  }
}

/** Asks for a note's document, starting from what this tab already holds. */
export function openFrame(fileId: number, epoch: number, since: number): Record<string, unknown> {
  return { type: FRAME.open, file_id: fileId, epoch, since };
}

export function seedFrame(
  fileId: number,
  contentSeq: number,
  sealed: SealedWire,
  scope: { keyScopeId: number; keyVersion: number },
  signature: Uint8Array | null,
): Record<string, unknown> {
  return {
    type: FRAME.seed,
    file_id: fileId,
    content_seq: contentSeq,
    payload: bytesToB64(sealed.ciphertext),
    nonce: bytesToB64(sealed.nonce),
    key_scope_id: scope.keyScopeId,
    key_version: scope.keyVersion,
    ...(signature ? { signature: bytesToB64(signature) } : {}),
  };
}

export function updateFrame(
  fileId: number,
  epoch: number,
  sealed: SealedWire,
  scope: { keyScopeId: number; keyVersion: number },
  signature: Uint8Array | null,
): Record<string, unknown> {
  return {
    type: FRAME.update,
    file_id: fileId,
    epoch,
    payload: bytesToB64(sealed.ciphertext),
    nonce: bytesToB64(sealed.nonce),
    key_scope_id: scope.keyScopeId,
    key_version: scope.keyVersion,
    ...(signature ? { signature: bytesToB64(signature) } : {}),
  };
}

export function awarenessFrame(fileId: number, sealed: SealedWire): Record<string, unknown> {
  return {
    type: FRAME.awareness,
    file_id: fileId,
    payload: bytesToB64(sealed.ciphertext),
    nonce: bytesToB64(sealed.nonce),
  };
}

export function closeFrame(fileId: number): Record<string, unknown> {
  return { type: FRAME.close, file_id: fileId };
}
