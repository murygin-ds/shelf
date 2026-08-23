/**
 * Domain values as words.
 *
 * These used to reach the screen raw: `{member.role}` in a select, `permission.toUpperCase()`
 * in the editor's meta line. The key stays what it always was — the server stores it, CSS
 * classes are built from it and the Claude view ranks by it — and only the label changes.
 */

import type { ImportProgress } from '@/api/transfer';
import type { Permission, Role } from '@/api/workspace';
import type { ProjectStatus } from '@/lib/claudeview';

import { m } from './messages';

export function roleLabel(role: Role): string {
  return m.enums.role[role];
}

export function permissionLabel(permission: Permission): string {
  return m.enums.permission[permission];
}

export function projectStatusLabel(status: ProjectStatus): string {
  return m.enums.projectStatus[status];
}

export function importPhaseLabel(phase: ImportProgress['phase']): string {
  return m.enums.importPhase[phase];
}
