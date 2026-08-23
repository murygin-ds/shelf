/**
 * Domain values the reader sees.
 *
 * Only the ones more than one area displays live here; a value shown on a single screen
 * belongs to that screen's namespace, because that is where somebody will want to bend it.
 * The audit action and the transfer skip reason are the two that look like they belong and
 * do not: Russian declines the thing being acted on, so both need a sentence template
 * rather than a word, and both are written where their sentence is.
 *
 * The keys stay English everywhere. CSS classes are built from them
 * (`styles[`status_${status}`]`), the Claude view ranks projects by them, and the server
 * stores them — translating a key would move all three.
 */

import type { Permission, Role } from '@/api/workspace';
import type { ProjectStatus } from '@/lib/claudeview';
import type { ImportProgress } from '@/api/transfer';

export const enums = {
  role: {
    owner: 'Owner',
    admin: 'Admin',
    editor: 'Editor',
    viewer: 'Viewer',
  } as Record<Role, string>,

  permission: {
    own: 'Can manage',
    edit: 'Can edit',
    comment: 'Can comment',
    view: 'Can view',
    none: 'No access',
  } as Record<Permission, string>,

  projectStatus: {
    planning: 'planning',
    active: 'active',
    paused: 'paused',
    done: 'done',
    unset: 'no status',
  } as Record<ProjectStatus, string>,

  // Written in normal case like every other label: the small caps are `--label-transform`
  // on the element, so the same words can stay lowercase in a language where capitals
  // read badly.
  importPhase: {
    vault: 'Creating the vault',
    folders: 'Building the tree',
    notes: 'Writing the notes',
    links: 'Linking',
  } as Record<ImportProgress['phase'], string>,
};
