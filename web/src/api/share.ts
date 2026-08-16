import { b64ToBytes, bytesToB64, fromUtf8, pad, unpad, utf8, type B64 } from '@/crypto/bytes';
import {
  generateShareSecret,
  openFromLink,
  sealForLink,
  shareKey,
  shareToken,
} from '@/crypto/sharelink';

import { api } from './client';
import type { NoteNode } from './workspace';

export interface ShareLinkDto {
  id: number;
  file_id: number;
  content_seq: number;
  creator_name?: string;
  permission: 'view';
  live: boolean;
  expires_at?: string;
  revoked_at?: string;
  last_viewed_at?: string;
  view_count: number;
  created_at: string;
}

export interface CreatedShareLink {
  link: ShareLinkDto;
  /**
   * Shown once. It goes in the URL fragment, which browsers never send — so the server
   * holds only its digest and could not reconstruct the link if it wanted to.
   */
  url: string;
}

export interface PublicNoteDto {
  client_id: string;
  meta: B64;
  meta_nonce: B64;
  content: B64;
  content_nonce: B64;
  published_at: string;
}

export interface PublicNote {
  name: string;
  body: string;
  publishedAt: string;
}

export function listShareLinks(fileId: number): Promise<{ links: ShareLinkDto[] }> {
  return api.get<{ links: ShareLinkDto[] }>(`/files/${fileId}/share-links`);
}

export function revokeShareLink(linkId: number): Promise<void> {
  return api.delete<void>(`/share-links/${linkId}`);
}

/**
 * Publishes a note read-only.
 *
 * The link carries its own copy of the note, sealed under a key derived from a secret
 * generated here — never the note's scope key. A scope covers a whole folder or a whole
 * vault, so handing that out would make one published note the key to everything sealed
 * beside it, and revoking the link would not take it back.
 *
 * The copy is a snapshot. A live link would publish every future edit silently, and an
 * edit that has already been served cannot be recalled.
 */
export async function createShareLink(
  note: NoteNode,
  body: string,
  contentSeq: number,
  expiresAt?: Date,
): Promise<CreatedShareLink> {
  const secret = generateShareSecret();
  const key = await shareKey(secret);

  const meta = await sealForLink(key, utf8(JSON.stringify({ name: note.name })), note.clientId);
  const content = await sealForLink(key, pad(utf8(body)), note.clientId);

  const link = await api.post<ShareLinkDto>(`/files/${note.id}/share-links`, {
    token_hash: bytesToB64(await shareToken(secret)),
    meta: bytesToB64(meta.ciphertext),
    meta_nonce: bytesToB64(meta.nonce),
    content: bytesToB64(content.ciphertext),
    content_nonce: bytesToB64(content.nonce),
    content_seq: contentSeq,
    ...(expiresAt ? { expires_at: expiresAt.toISOString() } : {}),
  });

  return { link, url: `${window.location.origin}/share#${secret}` };
}

/**
 * Opens a public link with no account behind it. Everything the server returns is
 * ciphertext; the title and the body appear only once the secret opens them here.
 */
export async function openShared(secret: string): Promise<PublicNote> {
  const dto = await api.post<PublicNoteDto>(
    '/public/share/lookup',
    { token_hash: bytesToB64(await shareToken(secret)) },
    { anonymous: true },
  );

  const key = await shareKey(secret);

  const meta = JSON.parse(
    fromUtf8(
      await openFromLink(
        key,
        { ciphertext: b64ToBytes(dto.meta), nonce: b64ToBytes(dto.meta_nonce) },
        dto.client_id,
      ),
    ),
  ) as { name: string };

  const body = unpad(
    await openFromLink(
      key,
      { ciphertext: b64ToBytes(dto.content), nonce: b64ToBytes(dto.content_nonce) },
      dto.client_id,
    ),
  );

  return { name: meta.name, body: fromUtf8(body), publishedAt: dto.published_at };
}
