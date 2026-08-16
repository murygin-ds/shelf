import { exportKey, generateKey } from '@/crypto/aead';
import { b64ToBytes, bytesToB64, type B64 } from '@/crypto/bytes';
import {
  decryptContent,
  decryptMeta,
  encryptContent,
  encryptMeta,
  type EntityMeta,
  type EntityRef,
  type EntityType,
  isLocked,
  sealInfo,
} from '@/crypto/envelope';
import { type Identity, splitPublicBlob } from '@/crypto/identity';
import { type GroupKeyDto, type KeyGrantDto, ScopeKeyring } from '@/crypto/keyring';
import { seal } from '@/crypto/sealedbox';
import { signRevision } from '@/crypto/signature';

import { api } from './client';

export type Permission = 'none' | 'view' | 'comment' | 'edit' | 'own';
export type Role = 'owner' | 'admin' | 'editor' | 'viewer';

interface NodeDto {
  id: number;
  client_id: string;
  vault_id: number;
  /** Names the scope in a sealed key. Not the node's own client id, which names the slot. */
  key_scope_client_id: string;
  key_scope_id: number;
  key_version: number;
  meta: B64;
  meta_nonce: B64;
  inherit_access: boolean;
  permission: Permission;
  own_scope: boolean;
  grant_count: number;
  updated_seq: number;
  updated_by: number | null;
  deleted_at: string | null;
  updated_at: string;
}

export interface FolderDto extends NodeDto {
  parent_id: number | null;
  depth: number;
  position: number;
}

export interface FileDto extends NodeDto {
  folder_id: number | null;
  content?: B64;
  content_nonce?: B64;
  content_seq: number;
  content_size: number;
}

export interface VaultSummaryDto {
  id: number;
  client_id: string;
  key_scope_client_id: string;
  owner_id: number;
  meta: B64;
  meta_nonce: B64;
  change_seq: number;
  role: Role;
  key_state: 'ok' | 'pending_key' | 'pending_rotation';
  key_scope_id: number;
  key_version: number;
  note_count: number;
  member_count: number;
}

/** A node after decryption. `locked` marks one the viewer holds no key for. */
export interface Node {
  id: number;
  clientId: string;
  vaultId: number;
  /** What a sealed key for this node names. Sealing to clientId instead silently fails. */
  keyScopeClientId: string;
  name: string;
  icon: string | undefined;
  locked: boolean;
  permission: Permission;
  keyScopeId: number;
  keyVersion: number;
  ownScope: boolean;
  grantCount: number;
  updatedAt: string;
  updatedBy: number | null;
}

export interface FolderNode extends Node {
  parentId: number | null;
  depth: number;
  position: number;
}

export interface NoteNode extends Node {
  folderId: number | null;
  contentSeq: number;
  contentSize: number;
}

export interface Vault {
  id: number;
  clientId: string;
  keyScopeClientId: string;
  name: string;
  emoji: string | undefined;
  locked: boolean;
  role: Role;
  keyState: VaultSummaryDto['key_state'];
  keyScopeId: number;
  keyVersion: number;
  noteCount: number;
  memberCount: number;
  changeSeq: number;
}

export interface Tree {
  folders: FolderNode[];
  notes: NoteNode[];
}

export interface Scope {
  id: number;
  /** Names the scope inside the additional data and inside every sealed key for it. */
  clientId: string;
  version: number;
}

/** What a locked node shows instead of a name, matching the graph's masked labels. */
export const LOCKED_NAME = '••••••';

const WRAP_ALGORITHM = 'ecdh-p256-hkdf-a256gcm';

/** The scope a node in the tree is sealed under. */
function scopeOfNode(node: Node): Scope {
  return { id: node.keyScopeId, clientId: node.keyScopeClientId, version: node.keyVersion };
}

/** The scope a stored row is sealed under, as the row itself reports it. */
function scopeOf(dto: { key_scope_id: number; key_scope_client_id: string; key_version: number }): Scope {
  return { id: dto.key_scope_id, clientId: dto.key_scope_client_id, version: dto.key_version };
}

function ref(
  vaultId: number,
  entity: EntityType,
  clientId: string,
  scope: Scope,
): EntityRef {
  return { vaultId, entity, entityId: clientId, scopeClientId: scope.clientId, keyVersion: scope.version };
}

/**
 * Creates a vault. The content key is generated here and sealed to the creator's own
 * public key, so the server stores a name it cannot read and a key it cannot open.
 *
 * Both the vault and its key scope are named by ids chosen here, which is what lets the
 * metadata and the sealed key be bound to their final identities in one request.
 */
export async function createVault(
  name: string,
  emoji: string | undefined,
  identity: Identity,
): Promise<{ id: number }> {
  const clientId = crypto.randomUUID();
  const scopeClientId = crypto.randomUUID();
  const key = await generateKey();

  const sealedMeta = await encryptMeta(key, meta(name, emoji), vaultRef(clientId, scopeClientId, 1));

  const box = await seal(
    splitPublicBlob(identity.publicBlob).seal,
    await exportKey(key),
    sealInfo(scopeClientId, 1),
  );

  return api.post<{ id: number }>('/vaults', {
    client_id: clientId,
    scope_client_id: scopeClientId,
    meta: bytesToB64(sealedMeta.ciphertext),
    meta_nonce: bytesToB64(sealedMeta.nonce),
    wrapped_key: bytesToB64(box.blob),
    key_nonce: bytesToB64(box.nonce),
    wrap_algorithm: WRAP_ALGORITHM,
  });
}

// The serial vault id does not exist when the name is sealed, so the additional data names
// the vault by its client id. That is enough to pin the slot: the id is unique and the key
// that opens it belongs to this vault only.
//
// The version has to be passed in rather than assumed: a rotation re-seals the name under
// the new one, and reading it back at v1 forever would show the vault as locked the moment
// its key was rotated.
function vaultRef(clientId: string, scopeClientId: string, keyVersion: number): EntityRef {
  return { vaultId: 0, entity: 'vault', entityId: clientId, scopeClientId, keyVersion };
}

export async function listVaults(identity: Identity): Promise<Vault[]> {
  const { vaults } = await api.get<{ vaults: VaultSummaryDto[] }>('/vaults');

  return Promise.all(vaults.map((summary) => openVault(summary, identity)));
}

async function openVault(summary: VaultSummaryDto, identity: Identity): Promise<Vault> {
  const keyring = await loadKeyring(summary.id, identity);
  const key = keyring.get(summary.key_scope_id, summary.key_version);

  const opened = await decryptMeta(
    key,
    { ciphertext: b64ToBytes(summary.meta), nonce: b64ToBytes(summary.meta_nonce) },
    vaultRef(summary.client_id, summary.key_scope_client_id, summary.key_version),
  );

  const locked = isLocked(opened);

  return {
    id: summary.id,
    clientId: summary.client_id,
    keyScopeClientId: summary.key_scope_client_id,
    name: locked ? LOCKED_NAME : opened.name,
    emoji: locked ? undefined : opened.icon,
    locked,
    role: summary.role,
    keyState: summary.key_state,
    keyScopeId: summary.key_scope_id,
    keyVersion: summary.key_version,
    noteCount: summary.note_count,
    memberCount: summary.member_count,
    changeSeq: summary.change_seq,
  };
}

/**
 * Reseals the vault's own name and icon. The scope key never changes here, so the current
 * key version has to be carried into the additional data — sealing at v1 after a rotation
 * would make the vault read as locked.
 */
export async function updateVaultMeta(
  vault: Vault,
  name: string,
  icon: string | undefined,
  keyring: ScopeKeyring,
): Promise<void> {
  const scope: Scope = {
    id: vault.keyScopeId,
    clientId: vault.keyScopeClientId,
    version: vault.keyVersion,
  };

  const sealed = await encryptMeta(
    requireKey(keyring, scope),
    meta(name, icon),
    vaultRef(vault.clientId, vault.keyScopeClientId, vault.keyVersion),
  );

  await api.patch<unknown>(`/vaults/${vault.id}`, {
    meta: bytesToB64(sealed.ciphertext),
    meta_nonce: bytesToB64(sealed.nonce),
  });
}

export async function loadKeyring(vaultId: number, identity: Identity): Promise<ScopeKeyring> {
  // Both halves in one go: a scope key sealed to a group is bytes until the group's own
  // private key is in hand, and fetching them separately would leave a window where the
  // tree renders group folders as locked.
  const [{ grants }, { keys }] = await Promise.all([
    api.get<{ grants: KeyGrantDto[] }>(`/vaults/${vaultId}/keys`),
    api.get<{ keys: GroupKeyDto[] }>(`/vaults/${vaultId}/group-keys`),
  ]);

  return ScopeKeyring.fromGrants(grants, identity, keys);
}

export async function loadTree(
  vaultId: number,
  keyring: ScopeKeyring,
  trashed = false,
): Promise<Tree> {
  const data = await api.get<{ folders: FolderDto[]; files: FileDto[] }>(
    `/vaults/${vaultId}/${trashed ? 'trash' : 'tree'}`,
  );

  const folders = await Promise.all(data.folders.map((dto) => openFolder(dto, keyring)));
  const notes = await Promise.all(data.files.map((dto) => openNote(dto, keyring)));

  return { folders, notes };
}

async function openFolder(dto: FolderDto, keyring: ScopeKeyring): Promise<FolderNode> {
  return {
    ...(await openNode(dto, 'folder', keyring)),
    parentId: dto.parent_id,
    depth: dto.depth,
    position: dto.position,
  };
}

async function openNote(dto: FileDto, keyring: ScopeKeyring): Promise<NoteNode> {
  return {
    ...(await openNode(dto, 'file', keyring)),
    folderId: dto.folder_id,
    contentSeq: dto.content_seq,
    contentSize: dto.content_size,
  };
}

async function openNode(dto: NodeDto, entity: EntityType, keyring: ScopeKeyring): Promise<Node> {
  const scope = scopeOf(dto);

  const opened = await decryptMeta(
    keyring.get(scope.id, scope.version),
    { ciphertext: b64ToBytes(dto.meta), nonce: b64ToBytes(dto.meta_nonce) },
    ref(dto.vault_id, entity, dto.client_id, scope),
  );

  const locked = isLocked(opened);

  return {
    id: dto.id,
    clientId: dto.client_id,
    vaultId: dto.vault_id,
    keyScopeClientId: dto.key_scope_client_id,
    name: locked ? LOCKED_NAME : opened.name,
    icon: locked ? undefined : opened.icon,
    locked,
    permission: dto.permission,
    keyScopeId: scope.id,
    keyVersion: scope.version,
    ownScope: dto.own_scope,
    grantCount: dto.grant_count,
    updatedAt: dto.updated_at,
    updatedBy: dto.updated_by,
  };
}

export async function createFolder(
  vaultId: number,
  parentId: number | null,
  name: string,
  scope: Scope,
  keyring: ScopeKeyring,
): Promise<FolderNode> {
  const clientId = crypto.randomUUID();
  const key = requireKey(keyring, scope);

  const sealed = await encryptMeta(key, meta(name), ref(vaultId, 'folder', clientId, scope));

  const dto = await api.post<FolderDto>(`/vaults/${vaultId}/folders`, {
    client_id: clientId,
    parent_id: parentId,
    meta: bytesToB64(sealed.ciphertext),
    meta_nonce: bytesToB64(sealed.nonce),
    key_scope_id: scope.id,
    key_version: scope.version,
  });

  return openFolder(dto, keyring);
}

export async function createNote(
  vaultId: number,
  folderId: number | null,
  title: string,
  scope: Scope,
  keyring: ScopeKeyring,
): Promise<NoteNode> {
  const clientId = crypto.randomUUID();
  const key = requireKey(keyring, scope);
  const slot = ref(vaultId, 'file', clientId, scope);

  const sealedMeta = await encryptMeta(key, meta(title), slot);
  const sealedBody = await encryptContent(key, '', slot);

  const dto = await api.post<FileDto>(`/vaults/${vaultId}/files`, {
    client_id: clientId,
    folder_id: folderId,
    meta: bytesToB64(sealedMeta.ciphertext),
    meta_nonce: bytesToB64(sealedMeta.nonce),
    content: bytesToB64(sealedBody.ciphertext),
    content_nonce: bytesToB64(sealedBody.nonce),
    key_scope_id: scope.id,
    key_version: scope.version,
  });

  return openNote(dto, keyring);
}

export async function renameNode(
  node: FolderNode | NoteNode,
  kind: 'folder' | 'file',
  name: string,
  icon: string | undefined,
  keyring: ScopeKeyring,
): Promise<void> {
  const scope = scopeOfNode(node);
  const key = requireKey(keyring, scope);

  const sealed = await encryptMeta(
    key,
    meta(name, icon),
    ref(node.vaultId, kind, node.clientId, scope),
  );

  await api.patch<unknown>(`/${kind === 'folder' ? 'folders' : 'files'}/${node.id}`, {
    meta: bytesToB64(sealed.ciphertext),
    meta_nonce: bytesToB64(sealed.nonce),
  });
}

export interface NoteBody {
  body: string;
  contentSeq: number;
  locked: boolean;
}

export async function readNote(noteId: number, keyring: ScopeKeyring): Promise<NoteBody> {
  const dto = await api.get<FileDto>(`/files/${noteId}`);
  const scope = scopeOf(dto);

  const opened = await decryptContent(
    keyring.get(scope.id, scope.version),
    {
      ciphertext: b64ToBytes(dto.content ?? ''),
      nonce: b64ToBytes(dto.content_nonce ?? ''),
    },
    ref(dto.vault_id, 'file', dto.client_id, scope),
  );

  const locked = isLocked(opened);

  return { body: locked ? '' : opened, contentSeq: dto.content_seq, locked };
}

/**
 * Writes a body and signs it. Returns the next content sequence, which the following write
 * has to carry.
 *
 * The signature covers the slot as well as the ciphertext, so it cannot be moved onto
 * another note or replayed as a later version. Signing the sequence that is about to be
 * written means predicting it — the server increments by one, and a wrong guess only makes
 * the revision read as unsigned rather than corrupting anything.
 */
export interface NotePayload {
  content: B64;
  content_nonce: B64;
  key_scope_id: number;
  key_version: number;
  signature?: B64;
}

/**
 * Seals a body without sending it.
 *
 * It is split from the send so a write that meets no network can be queued as ciphertext
 * rather than as text: the outbox lives in the same IndexedDB as everything else, and the
 * rule there is that nothing readable is ever stored.
 */
export async function sealNote(
  note: NoteNode,
  body: string,
  contentSeq: number,
  keyring: ScopeKeyring,
  identity?: Identity,
): Promise<NotePayload> {
  const scope = scopeOfNode(note);
  const key = requireKey(keyring, scope);
  const at = ref(note.vaultId, 'file', note.clientId, scope);

  const sealed = await encryptContent(key, body, at);

  // The signature covers the sequence the server is about to assign. Predicting it is safe:
  // a wrong guess only makes the revision read as unsigned.
  const signature = identity
    ? bytesToB64(await signRevision(identity, at, contentSeq + 1, sealed))
    : undefined;

  return {
    content: bytesToB64(sealed.ciphertext),
    content_nonce: bytesToB64(sealed.nonce),
    // The key is part of the lock: content_seq alone does not move when a re-key does, so
    // a write held up across a rotation has to be refused rather than relabelled.
    key_scope_id: scope.id,
    key_version: scope.version,
    ...(signature ? { signature } : {}),
  };
}

/** Sends a sealed body. Returns the next content sequence, which the following write carries. */
export async function sendNote(
  noteId: number,
  payload: NotePayload,
  contentSeq: number,
): Promise<number> {
  const written = await api.put<{ content_seq: number }>(`/files/${noteId}/content`, payload, {
    headers: { 'If-Match': String(contentSeq) },
  });

  return written.content_seq;
}

/** Seals a body and sends it. */
export async function writeNote(
  note: NoteNode,
  body: string,
  contentSeq: number,
  keyring: ScopeKeyring,
  identity?: Identity,
): Promise<number> {
  return sendNote(note.id, await sealNote(note, body, contentSeq, keyring, identity), contentSeq);
}

export const trashFolder = (id: number) => api.delete<void>(`/folders/${id}`);
export const trashNote = (id: number) => api.delete<void>(`/files/${id}`);
export const restoreFolder = (id: number) => api.post<void>(`/folders/${id}/restore`);
export const restoreNote = (id: number) => api.post<void>(`/files/${id}/restore`);

// Purging destroys the ciphertext. Nothing brings it back, which is why the UI asks.
export const purgeFolder = (id: number) => api.delete<void>(`/folders/${id}/purge`);
export const purgeNote = (id: number) => api.delete<void>(`/files/${id}/purge`);

function meta(name: string, icon?: string | undefined): EntityMeta {
  return icon === undefined ? { name } : { name, icon };
}

function requireKey(keyring: ScopeKeyring, scope: Scope): CryptoKey {
  const key = keyring.get(scope.id, scope.version);
  if (!key) throw new Error('no key for this scope — the vault is not fully unlocked');

  return key;
}

export interface DeltaDto {
  cursor: number;
  has_more: boolean;
  full_resync_required: boolean;
  folders: FolderDto[];
  files: FileDto[];
  purged: { folders: number[]; files: number[] };
}

export function fetchDelta(vaultId: number, cursor: number, limit = 500): Promise<DeltaDto> {
  return api.get<DeltaDto>(`/vaults/${vaultId}/sync?cursor=${cursor}&limit=${limit}`);
}

/** Hydration for the local index: bodies in bulk, bounded by what the server accepts. */
export const BULK_LIMIT = 200;

export function fetchBodies(vaultId: number, ids: number[]): Promise<{ files: FileDto[] }> {
  return api.post<{ files: FileDto[] }>(`/vaults/${vaultId}/files/bulk`, { ids });
}

/** Decrypts one cached body. Returns null when the viewer holds no key for it. */
export async function openBody(
  dto: {
    vault_id: number;
    client_id: string;
    key_scope_id: number;
    key_scope_client_id: string;
    key_version: number;
  },
  content: B64,
  contentNonce: B64,
  keyring: ScopeKeyring,
): Promise<string | null> {
  const scope = scopeOf(dto);

  const opened = await decryptContent(
    keyring.get(scope.id, scope.version),
    { ciphertext: b64ToBytes(content), nonce: b64ToBytes(contentNonce) },
    ref(dto.vault_id, 'file', dto.client_id, scope),
  );

  return isLocked(opened) ? null : opened;
}

export async function openFolderDto(dto: FolderDto, keyring: ScopeKeyring): Promise<FolderNode> {
  return openFolder(dto, keyring);
}

export async function openNoteDto(dto: FileDto, keyring: ScopeKeyring): Promise<NoteNode> {
  return openNote(dto, keyring);
}
