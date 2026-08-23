import type { EditorState, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { m } from '@/i18n';
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

const words = m.editor.menu;

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
      id: 'row',
      label: words.row,
      icon: 'list',
      items: [
        ...(header
          ? []
          : [
              {
                id: 'row-above',
                label: words.rowAbove,
                icon: 'plus' as const,
                onSelect: () => insertRow(ref, body),
              },
            ]),
        {
          id: 'row-below',
          label: words.rowBelow,
          icon: 'plus',
          onSelect: () => insertRow(ref, header ? 0 : body + 1),
        },
        ...(header || rows < 1
          ? []
          : [
              {
                id: 'row-delete',
                label: words.rowDelete,
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
      id: 'column',
      label: words.column,
      icon: 'table',
      items: [
        {
          id: 'column-left',
          label: words.columnLeft,
          icon: 'plus',
          onSelect: () => insertColumn(ref, column),
        },
        {
          id: 'column-right',
          label: words.columnRight,
          icon: 'plus',
          onSelect: () => insertColumn(ref, column + 1),
        },
        ...(columns < 2
          ? []
          : [
              {
                id: 'column-delete',
                label: words.columnDelete,
                icon: 'trash' as const,
                danger: true,
                separated: true,
                onSelect: () => removeColumn(ref, column),
              },
            ]),
      ],
    },
    {
      id: 'table-delete',
      label: words.tableDelete,
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
  // The formatting verbs answer with a null spec while the state is read-only, so they are
  // already inert — but Paste and Cut dispatch changes of their own, and an entry that does
  // nothing is worse than one that is not there.
  const writable = clipboard && !view.state.readOnly;

  const head: MenuEntry[] = link
    ? [
        {
          id: 'open',
          label: words.open,
          icon: 'doc',
          onSelect: () => onOpenLink({ target: link.target, where: 'here' }),
        },
        {
          id: 'open-tab',
          label: words.openTab,
          icon: 'layers',
          separated: true,
          onSelect: () => onOpenLink({ target: link.target, where: 'tab' }),
        },
      ]
    : [];

  const headings: MenuEntry = {
    kind: 'submenu',
    id: 'heading',
    label: words.heading,
    icon: 'hash',
    items: [
      { id: 'heading-1', label: words.heading1, icon: 'hash', onSelect: run((state) => setHeading(state, 1)) },
      { id: 'heading-2', label: words.heading2, icon: 'hash', onSelect: run((state) => setHeading(state, 2)) },
      { id: 'heading-3', label: words.heading3, icon: 'hash', onSelect: run((state) => setHeading(state, 3)) },
      {
        id: 'heading-normal',
        label: words.normal,
        icon: 'text',
        separated: true,
        onSelect: run((state) => setHeading(state, 0)),
      },
    ],
  };

  const lists: MenuEntry = {
    kind: 'submenu',
    id: 'list',
    label: words.list,
    icon: 'list',
    items: [
      { id: 'list-bullet', label: words.bullet, icon: 'list', onSelect: run((state) => toggleLinePrefix(state, '- ')) },
      { id: 'list-task', label: words.task, icon: 'check', onSelect: run((state) => toggleLinePrefix(state, '- [ ] ')) },
      { id: 'list-quote', label: words.quote, icon: 'quote', onSelect: run((state) => toggleLinePrefix(state, '> ')) },
    ],
  };

  const table: MenuEntry = {
    kind: 'submenu',
    id: 'table',
    label: words.table,
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

  const paste: MenuEntry[] = writable
    ? [
        {
          id: 'paste',
          label: words.paste,
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

  const copy: MenuEntry[] = clipboard
    ? [
        {
          id: 'copy',
          label: words.copy,
          icon: 'copy',
          hint: `${MOD}C`,
          separated: !writable,
          onSelect: () => {
            const { from, to } = view.state.selection.main;

            void navigator.clipboard.writeText(view.state.doc.sliceString(from, to)).catch(() => undefined);
            view.focus();
          },
        },
      ]
    : [];

  // Reading: everything below either writes or is inert, so what is left is where a link
  // goes and what can be taken out of the note. An empty list is not a menu — the caller
  // hands the event back to the platform when nothing is offered.
  if (view.state.readOnly) return [...head, ...(selected ? copy : [])];

  if (!selected) {
    return [
      ...head,
      table,
      headings,
      lists,
      { id: 'divider', label: words.divider, icon: 'rule', onSelect: run((state) => insertBlock(state, '---')) },
      {
        id: 'code-block',
        label: words.codeBlock,
        icon: 'code',
        onSelect: run((state) => insertBlock(state, '```\n\n```')),
      },
      ...paste,
    ];
  }

  const cut: MenuEntry[] = writable
    ? [
        {
          id: 'cut',
          label: words.cut,
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
      ]
    : [];

  return [
    ...head,
    {
      id: 'bold',
      label: words.bold,
      icon: 'bold',
      hint: `${MOD}B`,
      onSelect: run((state) => toggleWrap(state, MARKERS.bold)),
    },
    {
      id: 'italic',
      label: words.italic,
      icon: 'italic',
      hint: `${MOD}I`,
      onSelect: run((state) => toggleWrap(state, MARKERS.italic)),
    },
    {
      id: 'strike',
      label: words.strike,
      icon: 'strike',
      onSelect: run((state) => toggleWrap(state, MARKERS.strike)),
    },
    {
      id: 'code',
      label: words.code,
      icon: 'code',
      hint: `${MOD}E`,
      onSelect: run((state) => toggleWrap(state, MARKERS.code)),
    },
    headings,
    {
      kind: 'submenu',
      id: 'case',
      label: words.case,
      icon: 'case',
      items: [
        { id: 'case-upper', label: words.upper, icon: 'case', onSelect: run((state) => changeCase(state, 'upper')) },
        { id: 'case-lower', label: words.lower, icon: 'case', onSelect: run((state) => changeCase(state, 'lower')) },
        { id: 'case-title', label: words.title, icon: 'case', onSelect: run((state) => changeCase(state, 'title')) },
        {
          id: 'case-sentence',
          label: words.sentence,
          icon: 'case',
          onSelect: run((state) => changeCase(state, 'sentence')),
        },
      ],
    },
    lists,
    { id: 'link', label: words.link, icon: 'link', onSelect: run(wrapWikilink) },
    ...cut,
    ...copy,
    ...paste,
  ];
}
