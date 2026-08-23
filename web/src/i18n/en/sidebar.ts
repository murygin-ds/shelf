/**
 * The left panel: the nav above, the tree, the tags below it, and the icon picker.
 *
 * Four of these are content rather than labels. `noteTitleInitial` and `folderNameInitial`
 * are what the name prompt opens with, and whatever the reader does not overwrite becomes
 * the real name of a note or a folder — in the tree, in the graph and in the export. They
 * are worded exactly as `shell.menu` words them, because the same two prompts are reachable
 * from the right-button menu over the workspace.
 */

export const sidebar = {
  quickFind: 'Quick find',

  notes: 'Notes',
  search: 'Search',
  graph: 'Graph',
  trash: 'Trash',

  /** The heading over the tree while no vault name is known yet. */
  vault: 'Vault',
  tags: 'Tags',
  soloKey: 'Solo key',

  emptyReadOnly:
    'Nothing here yet, and read-only mode is on — turn it off in the account menu to add anything.',
  empty:
    'Nothing here yet. Add a folder or a note — both are encrypted before they leave this device.',

  newFolder: 'New folder',
  newNote: 'New note',
  newHere: 'New here',
  newFolderHere: 'New folder here',
  newNoteHere: 'New note here',
  collapse: 'Collapse',
  expand: 'Expand',
  permissions: 'Permissions',
  changeIcon: 'Change icon',
  moveToTrash: 'Move to trash',

  namePrompt: 'Name',
  noteTitlePrompt: 'Note title',
  noteTitleInitial: 'Untitled',
  folderNamePrompt: 'Folder name',
  folderNameInitial: 'New folder',

  iconLabel: 'Icon',
  iconReset: 'Reset',
};
