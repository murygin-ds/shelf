/**
 * The note on screen: the tab strip, the meta line, the body and the right button in it.
 *
 * The meta line has its own words for a permission. `enums.permission` answers "what may
 * this person do with this note" in a sentence — the right answer in a member list, too
 * long for a line of 10.5px monospace that is already stating three other facts.
 */

import type { Permission } from '@/api/workspace';

export const editor = {
  tab: {
    close: 'Close',
    closeOthers: 'Close others',
    closeAll: 'Close all',
  },

  changeIcon: 'Change icon',
  body: 'Note body',

  updated: (when: string) => `Updated ${when}`,
  readOnly: 'Read only',
  encrypting: 'Encrypting…',
  unsaved: 'Unsaved',

  access: {
    own: 'Full access',
    edit: 'Editing',
    comment: 'Commenting',
    view: 'Reading',
    none: 'No access',
  } as Record<Permission, string>,

  peer: (name: string, access: string, saving: boolean) =>
    `${name} · ${access}${saving ? ' · saving' : ''}`,

  locked:
    'This note is encrypted under a key you do not hold. The server cannot help — only someone who already has access can grant it.',

  placeholder: {
    empty: 'This note is empty.',
    write: 'Write in markdown. Everything here is encrypted before it leaves this device.',
  },

  conflict: {
    lead: 'Someone else saved this note while you were editing. The server holds ciphertext it cannot read, so it cannot merge the two versions — you have to choose.',
    reload: 'Discard mine and reload',
    fork: 'Save mine as a new note',
    copy: 'Copy to clipboard',
  },

  grid: {
    size: (rows: number, columns: number) => `${rows} by ${columns}`,
    empty: 'Table',
  },

  /** Content, not interface: this is written into the note body, where the reader edits it. */
  tableColumn: (index: number) => `Column ${index}`,

  menu: {
    row: 'Row',
    rowAbove: 'Insert above',
    rowBelow: 'Insert below',
    rowDelete: 'Delete row',

    column: 'Column',
    columnLeft: 'Insert left',
    columnRight: 'Insert right',
    columnDelete: 'Delete column',

    tableDelete: 'Delete table',

    open: 'Open',
    openTab: 'Open in new tab',

    heading: 'Heading',
    heading1: 'Heading 1',
    heading2: 'Heading 2',
    heading3: 'Heading 3',
    normal: 'Normal text',

    list: 'List',
    bullet: 'Bullet',
    task: 'Task',
    quote: 'Quote',

    table: 'Table',
    divider: 'Divider',
    codeBlock: 'Code block',

    bold: 'Bold',
    italic: 'Italic',
    strike: 'Strikethrough',
    code: 'Code',

    // Each of these says what it does by being written that way. A translation that reads
    // correctly but is not itself in the case it names has lost the label.
    case: 'Case',
    upper: 'UPPERCASE',
    lower: 'lowercase',
    title: 'Title Case',
    sentence: 'Sentence case',

    link: 'Link to a note',

    paste: 'Paste',
    copy: 'Copy',
    cut: 'Cut',
  },
};
