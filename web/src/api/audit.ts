import { api } from './client';

export type AuditAction =
  | 'member.joined'
  | 'member.role_changed'
  | 'member.removed'
  | 'grant.set'
  | 'grant.cleared'
  | 'invite.created'
  | 'invite.revoked'
  | 'key.protected'
  | 'key.rotated';

/**
 * One entry of the access history.
 *
 * Nodes and people arrive as ids: the server holds no names to give. The reader draws the
 * label from their own decrypted tree, and an entry about something they cannot see stays
 * an id — which is the truthful thing to show, not a gap.
 */
export interface AuditEventDto {
  id: number;
  actor_id?: number;
  actor_login?: string;
  actor_name?: string;
  action: AuditAction;
  target_type?: 'vault' | 'folder' | 'file';
  target_id?: number;
  subject_type?: 'user' | 'group' | 'invite';
  subject_id?: number;
  detail: Record<string, unknown>;
  created_at: string;
}

export interface AuditPage {
  events: AuditEventDto[];
  cursor: number;
}

export function readAudit(vaultId: number, before = 0, limit = 50): Promise<AuditPage> {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before > 0) query.set('before', String(before));

  return api.get<AuditPage>(`/vaults/${vaultId}/audit?${query.toString()}`);
}
