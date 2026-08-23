/**
 * The vault switcher: the trigger in the topbar, the list it opens, the verbs beneath it,
 * and the two questions asked before a vault is left or destroyed.
 *
 * `connectClaude` is the same phrase as `claude.consent.menuItem` — the consent screen
 * points at this entry by name, so the two have to be worded identically in every language
 * or the reader is sent looking for something that is not there.
 *
 * The group headings and the badge are written in ordinary case and shouted by
 * `--label-transform`, which is off in Russian.
 */

import { countedEn } from '../plural';

export const vaults = {
  none: 'No vault',

  mine: 'Mine',
  sharedWithMe: 'Shared with me',
  /** On a vault of one's own that somebody else also holds a key to. */
  sharedBadge: 'Shared',
  empty: 'No vaults yet. Create one, or join with a code someone sent you.',

  noKey: 'No key yet',
  solo: (notes: number) => `${countedEn(notes, ['note', 'notes'])} · only you`,
  withMembers: (notes: number, members: number) =>
    `${countedEn(notes, ['note', 'notes'])} · ${countedEn(members, ['member', 'members'])}`,

  labelPrompt: 'Your label for this vault',
  labelHint:
    'Only you ever see it: it is sealed to your own key, not the vault’s, so neither the ' +
    'other members nor the server can read it. Clear it with “Remove label”.',

  menu: {
    changeIcon: 'Change icon',
    addLabel: 'Add label',
    editLabel: 'Edit label',
    removeLabel: 'Remove label',
    deleteVault: 'Delete vault',
    leaveVault: 'Leave vault',
  },

  members: 'Members & sharing',
  keys: 'Keys & history',
  exportVault: 'Export vault…',
  newVault: 'New vault',
  importVault: 'Import vault…',
  connectClaude: 'Connect Claude…',
  join: 'Join with code',

  deleteTitle: (name: string) => `Delete “${name}”?`,
  deleteBody: (notes: number) =>
    `This destroys the vault and everything in it — ${countedEn(notes, ['note', 'notes'])}. ` +
    'The server keeps only ciphertext and deletes it; no key anyone kept will bring it back.',
  deleteBodyShared: (notes: number, members: number) =>
    `This destroys the vault and everything in it — ${countedEn(notes, ['note', 'notes'])}, ` +
    `for all ${members} members. The server keeps only ciphertext and deletes it; no key ` +
    'anyone kept will bring it back.',

  leaveTitle: (name: string) => `Leave “${name}”?`,
  leaveBody:
    'You lose access to it right away, and your keys for it are deleted here and on the ' +
    'server. Nothing you wrote is removed, and an admin has to invite you again to get back in.',
};
