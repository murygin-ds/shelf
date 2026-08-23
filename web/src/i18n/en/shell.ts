/**
 * The frame around everything: top bar, status bar, the right-button menu and ⌘K.
 *
 * Two of these are not labels but content. `vaultNameInitial`, `noteTitleInitial` and
 * `folderNameInitial` are what the name prompt starts with, and whatever the reader does
 * not overwrite becomes the actual name of a vault, a note or a folder — a Russian reader
 * ends up with a folder called «Новая папка», not one called "New folder".
 */

import { countedEn } from '../plural';

export const shell = {
  vaultNamePrompt: 'Vault name',
  vaultNameInitial: 'Personal',
  firstVaultLabel: 'Name your first vault',
  firstVaultHint:
    'Everything you write lives in a vault. Its key is generated on this device and sealed to your own public key, so nothing readable ever leaves it.',
  firstVaultConfirm: 'Create vault',

  unsaved: 'Unsaved',
  savedNotSent: 'Saved here · not sent',
  savedEncrypted: 'Saved · encrypted',

  readOnly: 'Read only',
  readOnlyTip: 'Nothing on this device writes to any vault. Click to turn it off.',

  emptyNote: 'Nothing open',
  emptyVault: 'No vault yet',
  emptyNoteLede:
    'Pick a note from the sidebar, or add one. Titles and bodies are encrypted here before anything is sent.',
  emptyNoteLedeReadOnly:
    'Pick a note from the sidebar. Read-only mode is on, so nothing here can be changed from this device.',
  emptyVaultLede:
    'Create a vault to start. Its key is generated on this device and sealed to your own public key.',
  emptyVaultLedeReadOnly:
    'There is nothing to read yet, and read-only mode is on — turn it off to create the first vault.',
  newVault: 'New vault',

  noVault: 'No vault',
  tree: (notes: number, folders: number) =>
    `${countedEn(notes, ['note', 'notes'])} · ${countedEn(folders, ['folder', 'folders'])}`,
  index: (covered: number, total: number) => `Index ${covered}/${total}`,
  counts: (words: number, chars: number) =>
    `${countedEn(words, ['word', 'words'])} · ${countedEn(chars, ['char', 'chars'])}`,

  menu: {
    cut: 'Cut',
    paste: 'Paste',
    selectAll: 'Select all',
    newNote: 'New note',
    newFolder: 'New folder',
    search: 'Search',
    graph: 'Graph',
    trash: 'Trash',
    noteTitlePrompt: 'Note title',
    noteTitleInitial: 'Untitled',
    folderNamePrompt: 'Folder name',
    folderNameInitial: 'New folder',
  },

  account: {
    profile: 'Profile',
    readOnlyMode: 'Read-only mode',
    /** The hint column, beside ⌘X and ⌘C rather than among the labels: it stays a token. */
    readOnlyOn: 'ON',
    lockKeys: 'Lock keys',
    signOut: 'Sign out',
    keyUnlocked: 'Key unlocked',
    keyLocked: 'Key locked',
  },

  palette: {
    placeholder: 'Find a note',
    notes: 'Notes',
    actions: 'Actions',
    nothing: 'No note matched.',
    everything: (term: string) => `Search everything for “${term}”`,
    navigate: '↑↓ Navigate',
    openHint: '↵ Open',
    local: 'Search is local',
  },
};
