import { exportKey, generateKey } from '@/crypto/aead';
import { b64ToBytes, bytesToB64, type B64 } from '@/crypto/bytes';
import {
  decryptContent,
  encryptContent,
  encryptMeta,
  type EntityRef,
  isLocked,
  sealInfo,
} from '@/crypto/envelope';
import { splitPublicBlob } from '@/crypto/identity';
import type { ScopeKeyring } from '@/crypto/keyring';
import { seal } from '@/crypto/sealedbox';

import { api } from './client';
import { fetchBodies, type FolderNode, type NoteNode, type Vault } from './workspace';

/** Matches the server's own batch ceiling; going over is a 422, not a truncation. */
const BATCH = 200;

export interface RekeySubjectDto {
  user_id: number;
  login: string;
  display_name: string;
  public_key: B64;
  fingerprint: string;
}

export interface RekeyPlanDto {
  id: number;
  scope_type: 'vault' | 'folder' | 'file';
  scope_ref_id: number;
  /** Names the scope the new key will belong to, whether this creates one or rotates one. */
  scope_client_id: string;
  creates_scope: boolean;
  covers_vault: boolean;
  from_version: number;
  to_version: number;
  folders: number[];
  files: number[];
  subjects: RekeySubjectDto[];
  expires_at: string;
}

export interface RekeyResultDto {
  scope_id: number;
  scope_client_id: string;
  key_version: number;
}

/** Reported as each row is sealed, so a vault-sized job shows progress rather than a spinner. */
export interface RekeyProgress {
  done: number;
  total: number;
}

/**
 * The decrypted rows the job will rewrite.
 *
 * It has to cover trashed rows as well as visible ones: they are still sealed under the old
 * key, and leaving them behind would mean a restore brings back something the rotation was
 * supposed to have put out of reach.
 */
export interface RekeySource {
  vault: Vault;
  folders: FolderNode[];
  notes: NoteNode[];
}

interface RekeyItem {
  entity_type: 'vault' | 'folder' | 'file';
  entity_id: number;
  meta: B64;
  meta_nonce: B64;
  content?: B64;
  content_nonce?: B64;
}

export function startRekey(
  vaultId: number,
  scopeType: 'vault' | 'folder' | 'file',
  scopeRefId: number,
  newScopeClientId?: string,
): Promise<RekeyPlanDto> {
  return api.post<RekeyPlanDto>(`/vaults/${vaultId}/rekeys`, {
    scope_type: scopeType,
    scope_ref_id: scopeRefId,
    ...(newScopeClientId ? { new_scope_client_id: newScopeClientId } : {}),
  });
}

export function abortRekey(rekeyId: number): Promise<void> {
  return api.delete<void>(`/rekeys/${rekeyId}`);
}

/**
 * Gives a node its own key, or rotates the key of a scope that already has one.
 *
 * Every row the plan names is written back under a new key that never leaves this device
 * except sealed to the people the plan lists. Until the commit lands nothing has changed:
 * a tab that dies here leaves a staging table the server throws away, not a vault half of
 * whose rows are unreadable.
 */
export async function runRekey(
  plan: RekeyPlanDto,
  source: RekeySource,
  keyring: ScopeKeyring,
  onProgress?: (progress: RekeyProgress) => void,
): Promise<RekeyResultDto> {
  if (plan.subjects.length === 0) {
    throw new Error('a new key that reaches nobody would lose these notes');
  }

  const key = await generateKey();
  const items = await reseal(plan, source, key, keyring, onProgress);
  const raw = await exportKey(key);

  const keyGrants = [];

  for (const subject of plan.subjects) {
    // The scope is named inside the seal, so a key meant for one scope cannot be replayed
    // into another.
    const box = await seal(
      splitPublicBlob(b64ToBytes(subject.public_key)).seal,
      raw,
      sealInfo(plan.scope_client_id, plan.to_version),
    );

    keyGrants.push({
      subject_type: 'user',
      subject_id: subject.user_id,
      wrapped_key: bytesToB64(box.blob),
      nonce: bytesToB64(box.nonce),
    });
  }

  for (let i = 0; i < items.length; i += BATCH) {
    await api.put<void>(`/rekeys/${plan.id}/items`, { items: items.slice(i, i + BATCH) });
  }

  return api.post<RekeyResultDto>(`/rekeys/${plan.id}/commit`, { key_grants: keyGrants });
}

/**
 * Seals every row the plan names under the new key. A row the caller could not open is a
 * hard stop: writing it back would replace real content with whatever the failure left.
 */
async function reseal(
  plan: RekeyPlanDto,
  source: RekeySource,
  key: CryptoKey,
  keyring: ScopeKeyring,
  onProgress?: (progress: RekeyProgress) => void,
): Promise<RekeyItem[]> {
  const items: RekeyItem[] = [];
  const total = plan.folders.length + plan.files.length + (plan.covers_vault ? 1 : 0);

  const ref = (entity: 'vault' | 'folder' | 'file', clientId: string): EntityRef => ({
    // The vault's own name is sealed before its serial id exists, so it is bound to the
    // client id alone — here as well as at creation.
    vaultId: entity === 'vault' ? 0 : source.vault.id,
    entity,
    entityId: clientId,
    scopeClientId: plan.scope_client_id,
    keyVersion: plan.to_version,
  });

  const step = async (
    entity: 'vault' | 'folder' | 'file',
    id: number,
    node: { clientId: string; name: string; icon?: string | undefined; locked: boolean } | undefined,
  ): Promise<{ item: RekeyItem; at: EntityRef }> => {
    if (!node || node.locked) throw new Error(`${entity} ${id} will not open with the key you hold`);

    const at = ref(entity, node.clientId);
    const sealed = await encryptMeta(
      key,
      { name: node.name, ...(node.icon ? { icon: node.icon } : {}) },
      at,
    );

    const item: RekeyItem = {
      entity_type: entity,
      entity_id: id,
      meta: bytesToB64(sealed.ciphertext),
      meta_nonce: bytesToB64(sealed.nonce),
    };

    items.push(item);
    onProgress?.({ done: items.length, total });

    return { item, at };
  };

  if (plan.covers_vault) {
    const { vault } = source;
    await step('vault', vault.id, {
      clientId: vault.clientId,
      name: vault.name,
      ...(vault.emoji ? { icon: vault.emoji } : {}),
      locked: vault.locked,
    });
  }

  for (const id of plan.folders) {
    await step('folder', id, source.folders.find((folder) => folder.id === id));
  }

  for (let i = 0; i < plan.files.length; i += BATCH) {
    const page = plan.files.slice(i, i + BATCH);
    const { files } = await fetchBodies(source.vault.id, page);
    const bodies = new Map(files.map((dto) => [dto.id, dto]));

    for (const id of page) {
      const note = source.notes.find((candidate) => candidate.id === id);
      const dto = bodies.get(id);
      if (!dto) throw new Error(`note ${id} is no longer readable`);

      const { item, at } = await step('file', id, note);

      const body = await decryptContent(
        keyring.get(dto.key_scope_id, dto.key_version),
        {
          ciphertext: b64ToBytes(dto.content ?? ''),
          nonce: b64ToBytes(dto.content_nonce ?? ''),
        },
        {
          vaultId: dto.vault_id,
          entity: 'file',
          entityId: dto.client_id,
          scopeClientId: dto.key_scope_client_id,
          keyVersion: dto.key_version,
        },
      );

      if (isLocked(body)) throw new Error(`note ${id} will not open with the key you hold`);

      const sealedBody = await encryptContent(key, body, at);

      item.content = bytesToB64(sealedBody.ciphertext);
      item.content_nonce = bytesToB64(sealedBody.nonce);
    }
  }

  return items;
}
