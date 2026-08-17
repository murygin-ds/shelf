import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { MOD, type MenuEntry } from '@/ui/ContextMenu';

import {
  MARKERS,
  buildTable,
  changeCase,
  insertBlock,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
  wrapWikilink,
} from './format';
import {
  insertColumn,
  insertRow,
  removeColumn,
  removeRow,
  removeTable,
  type TableCellRef,
} from './table';
import { GRID_HEIGHT, TableGrid } from './TableGrid';
import { wikilinkAt } from './wikilink';

/**
 * What the right button offers inside the note body.
 *
 * Replacing the platform menu is only defensible if what takes its place is better for the
 * job at hand — which for a markdown body means emphasis, headings, case and tables, and
 * keeping cut/copy/paste, since taking those away would leave the reader worse off than
 * before.
 */

export interface LinkTarget {
  target: string;
  where: 'here' | 'tab';
}

/**
 * The right button inside a table.
 *
 * A table has verbs no other block has, and they are all about the cell being pointed at:
 * which row, which column. That is what a context menu is for — it arrives knowing where it
 * was opened, which no toolbar above the table can.
 */
export function tableMenu(ref: TableCellRef): MenuEntry[] {
  const { row, column, columns, rows } = ref;

  // Row 0 is the header. It cannot be removed and nothing goes above it: a GFM table with
  // no header row is not a table at all.
  const header = row === 0;
  const body = row - 1;

  return [
    {
      kind: 'submenu',
      label: 'Row',
      icon: 'list',
      items: [
        ...(header
          ? []
          : [{ label: 'Insert above', icon: 'plus' as const, onSelect: () => insertRow(ref, body) }]),
        {
          label: 'Insert below',
          icon: 'plus',
          onSelect: () => insertRow(ref, header ? 0 : body + 1),
        },
        ...(header || rows < 1
          ? []
          : [
              {
                label: 'Delete row',
                icon: 'trash' as const,
                danger: true,
                separated: true,
                onSelect: () => removeRow(ref, body),
              },
            ]),
      ],
    },
    {
      kind: 'submenu',
      label: 'Column',
      icon: 'table',
      items: [
        { label: 'Insert left', icon: 'plus', onSelect: () => insertColumn(ref, column) },
        { label: 'Insert right', icon: 'plus', onSelect: () => insertColumn(ref, column + 1) },
        ...(columns < 2
          ? []
          : [
              {
                label: 'Delete column',
                icon: 'trash' as const,
                danger: true,
                separated: true,
                onSelect: () => removeColumn(ref, column),
              },
            ]),
      ],
    },
    {
      label: 'Delete table',
      icon: 'trash',
      danger: true,
      separated: true,
      onSelect: () => removeTable(ref),
    },
  ];
}

export function editorMenu(
  view: EditorView,
  pos: number,
  onOpenLink: (link: LinkTarget) => void,
): MenuEntry[] {
  const run = (build: (state: EditorState) => TransactionSpec | null) => () => {
    const spec = build(view.state);

    if (spec) view.dispatch(spec);

    // The menu took focus on its way open, and an unfocused editor renders every line as
    // finished markdown — so without this the markers just applied vanish on the spot.
    view.focus();
  };

  const selected = !view.state.selection.main.empty;
  const link = wikilinkAt(view.state, pos);
  const clipboard = typeof navigator !== 'undefined' && Boolean(navigator.clipboard);

  const head: MenuEntry[] = link
    ? [
        { label: 'Open', icon: 'doc', onSelect: () => onOpenLink({ target: link.target, where: 'here' }) },
        {
          label: 'Open in new tab',
          icon: 'layers',
          separated: true,
          onSelect: () => onOpenLink({ target: link.target, where: 'tab' }),
        },
      ]
    : [];

  const headings: MenuEntry = {
    kind: 'submenu',
    label: 'Heading',
    icon: 'hash',
    items: [
      { label: 'Heading 1', icon: 'hash', onSelect: run((state) => setHeading(state, 1)) },
      { label: 'Heading 2', icon: 'hash', onSelect: run((state) => setHeading(state, 2)) },
      { label: 'Heading 3', icon: 'hash', onSelect: run((state) => setHeading(state, 3)) },
      {
        label: 'Normal text',
        icon: 'text',
        separated: true,
        onSelect: run((state) => setHeading(state, 0)),
      },
    ],
  };

  const lists: MenuEntry = {
    kind: 'submenu',
    label: 'List',
    icon: 'list',
    items: [
      { label: 'Bullet', icon: 'list', onSelect: run((state) => toggleLinePrefix(state, '- ')) },
      { label: 'Task', icon: 'check', onSelect: run((state) => toggleLinePrefix(state, '- [ ] ')) },
      { label: 'Quote', icon: 'quote', onSelect: run((state) => toggleLinePrefix(state, '> ')) },
    ],
  };

  const table: MenuEntry = {
    kind: 'submenu',
    label: 'Table',
    icon: 'table',
    items: [
      {
        kind: 'panel',
        height: GRID_HEIGHT,
        render: (close) => (
          <TableGrid
            onPick={(rows, cols) => {
              close();
              run((state) => insertBlock(state, buildTable(rows, cols), 'after'))();
            }}
          />
        ),
      },
    ],
  };

  const paste: MenuEntry[] = clipboard
    ? [
        {
          label: 'Paste',
          icon: 'paste',
          separated: !selected,
          hint: `${MOD}V`,
          onSelect: () => {
            // Firefox refuses without a permission the user never granted. Nothing to
            // report there: the platform menu still has a Paste that works.
            void navigator.clipboard
              .readText()
              .then((text) => {
                if (text) view.dispatch(view.state.replaceSelection(text));
                view.focus();
              })
              .catch(() => view.focus());
          },
        },
      ]
    : [];

  if (!selected) {
    return [
      ...head,
      table,
      headings,
      lists,
      { label: 'Divider', icon: 'rule', onSelect: run((state) => insertBlock(state, '---')) },
      { label: 'Code block', icon: 'code', onSelect: run((state) => insertBlock(state, '```\n\n```')) },
      ...paste,
    ];
  }

  const cut: MenuEntry[] = clipboard
    ? [
        {
          label: 'Cut',
          icon: 'cut',
          separated: true,
          hint: `${MOD}X`,
          onSelect: () => {
            const { from, to } = view.state.selection.main;

            void navigator.clipboard.writeText(view.state.doc.sliceString(from, to)).catch(() => undefined);
            view.dispatch({ changes: { from, to, insert: '' }, selection: { anchor: from } });
            view.focus();
          },
        },
        {
          label: 'Copy',
          icon: 'copy',
          hint: `${MOD}C`,
          onSelect: () => {
            const { from, to } = view.state.selection.main;

            void navigator.clipboard.writeText(view.state.doc.sliceString(from, to)).catch(() => undefined);
            view.focus();
          },
        },
      ]
    : [];

  return [
    ...head,
    { label: 'Bold', icon: 'bold', hint: `${MOD}B`, onSelect: run((state) => toggleWrap(state, MARKERS.bold)) },
    { label: 'Italic', icon: 'italic', hint: `${MOD}I`, onSelect: run((state) => toggleWrap(state, MARKERS.italic)) },
    {
      label: 'Strikethrough',
      icon: 'strike',
      onSelect: run((state) => toggleWrap(state, MARKERS.strike)),
    },
    { label: 'Code', icon: 'code', hint: `${MOD}E`, onSelect: run((state) => toggleWrap(state, MARKERS.code)) },
    headings,
    {
      kind: 'submenu',
      label: 'Case',
      icon: 'case',
      items: [
        { label: 'UPPERCASE', icon: 'case', onSelect: run((state) => changeCase(state, 'upper')) },
        { label: 'lowercase', icon: 'case', onSelect: run((state) => changeCase(state, 'lower')) },
        { label: 'Title Case', icon: 'case', onSelect: run((state) => changeCase(state, 'title')) },
        {
          label: 'Sentence case',
          icon: 'case',
          onSelect: run((state) => changeCase(state, 'sentence')),
        },
      ],
    },
    lists,
    { label: 'Link to a note', icon: 'link', onSelect: run(wrapWikilink) },
    ...cut,
    ...paste,
  ];
}
