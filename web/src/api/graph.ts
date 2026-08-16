import { b64ToBytes, type B64 } from '@/crypto/bytes';
import { decryptMeta, isLocked } from '@/crypto/envelope';
import type { ScopeKeyring } from '@/crypto/keyring';

import { api } from './client';
import { LOCKED_NAME } from './workspace';

export interface GraphNodeDto {
  ref: string;
  file_id?: number;
  client_id?: string;
  folder_id?: number | null;
  key_scope_id?: number;
  key_scope_client_id?: string;
  key_version?: number;
  meta?: B64;
  meta_nonce?: B64;
  locked: boolean;
  degree: number;
}

export interface GraphDto {
  nodes: GraphNodeDto[];
  edges: Array<{ from: string; to: string }>;
  locked: number;
  reveals_locked: boolean;
}

/** A node after decryption. Masked ones carry a ref and a degree and nothing else. */
export interface GraphNode {
  ref: string;
  id: number | null;
  name: string;
  locked: boolean;
  degree: number;
}

export interface Graph {
  nodes: GraphNode[];
  edges: Array<{ from: string; to: string }>;
  locked: number;
  revealsLocked: boolean;
}

export interface BacklinkDto {
  id: number;
  client_id: string;
  vault_id: number;
  key_scope_id: number;
  key_scope_client_id: string;
  key_version: number;
  meta: B64;
  meta_nonce: B64;
  folder_id: number | null;
}

export interface Backlinks {
  links: Array<{ id: number; name: string; locked: boolean }>;
  /** How many notes point here that this reader cannot see. A count, never a list. */
  hidden: number;
}

export function setLinks(fileId: number, to: number[]): Promise<void> {
  return api.put<void>(`/files/${fileId}/links`, { to });
}

export async function backlinks(fileId: number, keyring: ScopeKeyring): Promise<Backlinks> {
  const data = await api.get<{ links: BacklinkDto[]; hidden: number }>(`/files/${fileId}/backlinks`);

  const links = await Promise.all(
    data.links.map(async (dto) => {
      const opened = await decryptMeta(
        keyring.get(dto.key_scope_id, dto.key_version),
        { ciphertext: b64ToBytes(dto.meta), nonce: b64ToBytes(dto.meta_nonce) },
        {
          vaultId: dto.vault_id,
          entity: 'file',
          entityId: dto.client_id,
          scopeClientId: dto.key_scope_client_id,
          keyVersion: dto.key_version,
        },
      );

      const locked = isLocked(opened);

      return { id: dto.id, name: locked ? LOCKED_NAME : opened.name, locked };
    }),
  );

  return { links, hidden: data.hidden };
}

/**
 * Reads the vault's link structure.
 *
 * Masked nodes arrive with no id and no ciphertext — only a position in the response and
 * how many visible notes touch them. Drawing them is what keeps the picture honest: a note
 * linked only through something invisible would otherwise look unconnected.
 */
export async function graph(vaultId: number, keyring: ScopeKeyring): Promise<Graph> {
  const data = await api.get<GraphDto>(`/vaults/${vaultId}/graph`);

  const nodes = await Promise.all(
    data.nodes.map(async (dto): Promise<GraphNode> => {
      if (dto.locked || !dto.meta || !dto.meta_nonce || !dto.client_id) {
        return { ref: dto.ref, id: null, name: LOCKED_NAME, locked: true, degree: dto.degree };
      }

      const opened = await decryptMeta(
        keyring.get(dto.key_scope_id ?? 0, dto.key_version ?? 0),
        { ciphertext: b64ToBytes(dto.meta), nonce: b64ToBytes(dto.meta_nonce) },
        {
          vaultId,
          entity: 'file',
          entityId: dto.client_id,
          scopeClientId: dto.key_scope_client_id ?? '',
          keyVersion: dto.key_version ?? 0,
        },
      );

      const locked = isLocked(opened);

      return {
        ref: dto.ref,
        id: dto.file_id ?? null,
        name: locked ? LOCKED_NAME : opened.name,
        locked,
        degree: dto.degree,
      };
    }),
  );

  return { nodes, edges: data.edges, locked: data.locked, revealsLocked: data.reveals_locked };
}
