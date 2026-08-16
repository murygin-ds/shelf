import { b64ToBytes, type B64 } from '@/crypto/bytes';
import { decryptContent, isLocked } from '@/crypto/envelope';
import type { ScopeKeyring } from '@/crypto/keyring';
import { type Authorship, checkAuthorship } from '@/crypto/signature';

import { api } from './client';
import type { NoteNode } from './workspace';

export interface RevisionDto {
  id: number;
  file_id: number;
  key_scope_id: number;
  key_scope_client_id: string;
  key_version: number;
  content_seq: number;
  content_size: number;
  author_id?: number;
  author_login?: string;
  author_name?: string;
  author_public_key?: B64;
  signature?: B64;
  signed: boolean;
  content?: B64;
  content_nonce?: B64;
  created_at: string;
}

export interface Revision {
  id: number;
  contentSeq: number;
  contentSize: number;
  authorName: string;
  authorLogin: string;
  signed: boolean;
  createdAt: string;
}

export interface RevisionBody extends Revision {
  body: string;
  locked: boolean;
  /**
   * Whether the signature actually checks out against the author's key. Checked here and
   * nowhere else: the server hands out both the body and the key, so a server-side verdict
   * would be the server vouching for itself.
   */
  authorship: Authorship;
}

export async function listRevisions(fileId: number): Promise<Revision[]> {
  const data = await api.get<{ revisions: RevisionDto[] }>(`/files/${fileId}/revisions`);

  return data.revisions.map(summarise);
}

/**
 * Reads one stored body and decides whether it is really the work of the name attached to
 * it. `view`, `comment` and `edit` are the same key, so without this check "written by" is
 * only ever what the server chose to say.
 */
export async function readRevision(
  note: NoteNode,
  revisionId: number,
  keyring: ScopeKeyring,
  roster?: Map<number, B64>,
): Promise<RevisionBody> {
  const dto = await api.get<RevisionDto>(`/files/${note.id}/revisions/${revisionId}`);

  const sealed = {
    ciphertext: b64ToBytes(dto.content ?? ''),
    nonce: b64ToBytes(dto.content_nonce ?? ''),
  };

  const ref = {
    vaultId: note.vaultId,
    entity: 'file' as const,
    entityId: note.clientId,
    scopeClientId: dto.key_scope_client_id,
    keyVersion: dto.key_version,
  };

  const opened = await decryptContent(keyring.get(dto.key_scope_id, dto.key_version), sealed, ref);
  const locked = isLocked(opened);

  // The key that verifies the signature arrives in the same response as the name it is
  // claimed for, so on its own it proves nothing: a server willing to lie would send its
  // own key and its own signature. Checking it against the roster this client already
  // holds is what makes the verdict worth reading.
  const known = dto.author_id === undefined ? undefined : roster?.get(dto.author_id);
  const trusted = roster && known !== undefined && known === dto.author_public_key;

  const authorship =
    roster && !trusted
      ? 'unknown-author'
      : await checkAuthorship(
          dto.author_public_key ? b64ToBytes(dto.author_public_key) : null,
          dto.signature ? b64ToBytes(dto.signature) : null,
          ref,
          dto.content_seq,
          sealed,
        );

  return { ...summarise(dto), body: locked ? '' : opened, locked, authorship };
}

function summarise(dto: RevisionDto): Revision {
  return {
    id: dto.id,
    contentSeq: dto.content_seq,
    contentSize: dto.content_size,
    authorName: dto.author_name ?? '',
    authorLogin: dto.author_login ?? '',
    signed: dto.signed,
    createdAt: dto.created_at,
  };
}
