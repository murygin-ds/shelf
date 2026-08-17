import { redo, undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { Facet, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

/**
 * Tables, drawn as tables and edited as tables.
 *
 * The rest of live preview styles the document's own characters, which cannot turn a run of
 * pipes into a grid — a table is the one construct whose markdown says something the text
 * itself cannot show. So the whole block is replaced by a real `<table>` whose cells are
 * editable, and the pipes are never shown at all: typing goes into the cell, and what the
 * cell says is written back as markdown.
 *
 * A block replacement may not come from a view plugin, which is why this is a state field
 * and not part of `livepreview.ts`.
 */

export type Align = 'left' | 'center' | 'right';

/** The cell the right button was pressed over, and everything needed to act on it. */
export interface TableCellRef {
  view: EditorView;
  table: HTMLElement;
  /** 0 is the header; body rows start at 1. */
  row: number;
  column: number;
  columns: number;
  /** How many body rows there are, so the menu knows whether a row can be removed. */
  rows: number;
}

export type TableMenuHandler = (event: MouseEvent, ref: TableCellRef) => void;

/**
 * Who opens the menu for a table.
 *
 * The widget is plain DOM inside CodeMirror and the menu is a React component several
 * layers up, so the two meet through a facet rather than an import.
 */
export const tableMenu = Facet.define<TableMenuHandler, TableMenuHandler | null>({
  combine: (values) => values[0] ?? null,
});

export interface TableModel {
  header: string[];
  rows: string[][];
  aligns: Align[];
}

const MIN_WIDTH = 3;

/**
 * The model as markdown, with the columns padded to a common width.
 *
 * Nobody reads this while they are editing — the grid is what they see — but the note is
 * still a markdown file that opens somewhere else, and a table whose source is ragged is a
 * table somebody else's editor will reformat into a diff.
 */
export function serialize(model: TableModel): string {
  const columns = Math.max(
    model.header.length,
    ...model.rows.map((row) => row.length),
    1,
  );

  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length));

  const header = Array.from({ length: columns }, (_, index) => cell(model.header[index] ?? ''));
  const rows = model.rows.map((row) =>
    Array.from({ length: columns }, (_, index) => cell(row[index] ?? '')),
  );

  const widths = header.map((text, index) =>
    Math.max(MIN_WIDTH, text.length, ...rows.map((row) => (row[index] ?? '').length)),
  );

  const rule = widths.map((width, index) => {
    switch (model.aligns[index]) {
      case 'center':
        return `:${'-'.repeat(Math.max(1, width - 2))}:`;
      case 'right':
        return `${'-'.repeat(Math.max(1, width - 1))}:`;
      default:
        return '-'.repeat(width);
    }
  });

  const line = (cells: string[]) =>
    `| ${cells.map((text, index) => pad(text, widths[index] ?? 0)).join(' | ')} |`;

  return [line(header), `| ${rule.join(' | ')} |`, ...rows.map(line)].join('\n');
}

/** `:---`, `---:` and `:---:` from the delimiter row, in column order. */
export function alignsOf(text: string): Align[] {
  return text
    .split('|')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.startsWith(':') && part.endsWith(':')) return 'center';

      return part.endsWith(':') ? 'right' : 'left';
    });
}

/**
 * The cells of one row, empty ones included.
 *
 * An empty cell produces no node at all, so the gaps have to be read off the pipes around
 * them — without that a blank row renders as a `<tr>` with nothing in it and the grid
 * collapses at exactly the moment a fresh table is at its emptiest.
 */
function cellsOf(state: EditorState, row: SyntaxNode, columns: number): string[] {
  const cells: string[] = [];
  let gap = false;

  for (let child = row.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableCell') {
      cells.push(state.doc.sliceString(child.from, child.to).trim().replace(/\\\|/g, '|'));
      gap = false;
      continue;
    }

    if (child.name !== 'TableDelimiter') continue;

    // Two pipes in a row with nothing between them: that gap is a cell.
    if (gap) cells.push('');

    gap = true;
  }

  while (cells.length < columns) cells.push('');

  return cells;
}

function modelOf(state: EditorState, table: SyntaxNode): TableModel | null {
  const header: string[] = [];
  const bodyRows: SyntaxNode[] = [];
  let aligns: Align[] = [];

  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (child.name === 'TableHeader') header.push(...cellsOf(state, child, 0));
    else if (child.name === 'TableRow') bodyRows.push(child);
    else if (child.name === 'TableDelimiter' && !aligns.length) {
      aligns = alignsOf(state.doc.sliceString(child.from, child.to));
    }
  }

  if (!header.length) return null;

  return { header, rows: bodyRows.map((row) => cellsOf(state, row, header.length)), aligns };
}

/** The extent of the table covering `pos`, looked up fresh rather than remembered. */
function tableAt(state: EditorState, pos: number): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1);

  while (node && node.name !== 'Table') node = node.parent;

  return node;
}

class TableWidget extends WidgetType {
  constructor(
    private readonly model: TableModel,
    private readonly source: string,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }

  override toDOM(view: EditorView): HTMLElement {
    const table = document.createElement('table');
    table.className = 'cm-md-grid';
    // The widget sits inside the editor's own contenteditable, so it has to opt out of it
    // explicitly; the cells then opt back in one at a time.
    table.contentEditable = 'false';

    const head = table.appendChild(document.createElement('thead'));
    head.appendChild(rowDOM(this.model.header, 'th', this.model.aligns));

    const body = table.appendChild(document.createElement('tbody'));
    for (const row of this.model.rows) body.appendChild(rowDOM(row, 'td', this.model.aligns));

    table.addEventListener('keydown', (event) => onKey(event, view, table));
    table.addEventListener('contextmenu', (event) => onContextMenu(event, view, table));
    table.addEventListener('focusout', () => {
      // A blur that lands on another cell of the same table is navigation, not an exit.
      queueMicrotask(() => {
        if (!table.contains(document.activeElement)) commit(view, table);
      });
    });

    return table;
  }

  /**
   * Rewrites the cells in place. Recreating the element would be simpler, but the cells are
   * where the caret is: a fresh DOM node on every keystroke would drop focus mid-word, and
   * writing a cell back to the document is a keystroke.
   */
  override updateDOM(dom: HTMLElement, _view: EditorView): boolean {
    const rows = dataRows(dom);
    if (rows.length !== this.model.rows.length + 1) return false;

    const all = [this.model.header, ...this.model.rows];

    for (const [index, row] of rows.entries()) {
      const cells = [...row.children] as HTMLElement[];
      const texts = all[index] ?? [];

      if (cells.length !== texts.length) return false;

      cells.forEach((cell, column) => {
        // Never the focused one: it holds the caret, and rewriting its text moves it.
        if (cell === document.activeElement) return;

        const text = texts[column] ?? '';
        if (cell.textContent !== text) cell.textContent = text;

        cell.style.textAlign = this.model.aligns[column] ?? 'left';
      });
    }

    return true;
  }

  // Everything inside is handled by the cells themselves.
  override ignoreEvent(): boolean {
    return true;
  }
}

function dataRows(table: HTMLElement): HTMLElement[] {
  return [...table.querySelectorAll('tr')];
}

/** Reads the table back out of the document, so a change acts on what is actually saved. */
function modelAt(view: EditorView, table: HTMLElement): { node: SyntaxNode; model: TableModel } | null {
  const node = tableAt(view.state, view.posAtDOM(table));
  if (!node) return null;

  const model = modelOf(view.state, node);

  return model ? { node, model } : null;
}

function rewrite(view: EditorView, table: HTMLElement, change: (model: TableModel) => void): void {
  // Whatever is half-typed in a cell goes in first, or the rewrite would drop it.
  commit(view, table);

  const found = modelAt(view, table);
  if (!found) return;

  change(found.model);

  view.dispatch({
    changes: { from: found.node.from, to: found.node.to, insert: serialize(found.model) },
  });
}

export function insertColumn(ref: TableCellRef, at: number): void {
  rewrite(ref.view, ref.table, (model) => {
    model.header.splice(at, 0, '');
    model.aligns.splice(at, 0, 'left');

    for (const row of model.rows) row.splice(at, 0, '');
  });
}

export function removeColumn(ref: TableCellRef, at: number): void {
  rewrite(ref.view, ref.table, (model) => {
    // A table with no columns is not a table, so the last one cannot be taken away.
    if (model.header.length < 2) return;

    model.header.splice(at, 1);
    model.aligns.splice(at, 1);

    for (const row of model.rows) row.splice(at, 1);
  });
}

/** `at` counts body rows: 0 is the first row under the header. */
export function insertRow(ref: TableCellRef, at: number): void {
  rewrite(ref.view, ref.table, (model) => {
    model.rows.splice(at, 0, model.header.map(() => ''));
  });
}

export function removeRow(ref: TableCellRef, at: number): void {
  rewrite(ref.view, ref.table, (model) => {
    model.rows.splice(at, 1);
  });
}

/**
 * Takes the block out entirely, trailing newline and all — a table left as a blank line
 * would still be a paragraph break nobody asked for.
 */
export function removeTable(ref: TableCellRef): void {
  const found = modelAt(ref.view, ref.table);
  if (!found) return;

  const doc = ref.view.state.doc;

  // A table normally has a blank line on each side. Taking the block and one newline would
  // leave both of those behind as a double gap, so when there is a blank line above, its
  // newline goes with the table.
  const above = found.node.from > 0 ? doc.lineAt(found.node.from - 1) : null;
  const from = above && above.text.trim() === '' ? above.to : found.node.from;

  ref.view.focus();
  ref.view.dispatch({
    changes: { from, to: Math.min(found.node.to + 1, doc.length) },
    selection: { anchor: from },
  });
}

function rowDOM(cells: string[], tag: 'th' | 'td', aligns: Align[]): HTMLElement {
  const row = document.createElement('tr');

  cells.forEach((text, index) => {
    const cell = row.appendChild(document.createElement(tag));

    cell.textContent = text;
    cell.contentEditable = 'true';
    cell.spellcheck = false;
    cell.style.textAlign = aligns[index] ?? 'left';
  });

  return row;
}

function readDOM(table: HTMLElement, aligns: Align[]): TableModel {
  const rows = dataRows(table).map((row) =>
    [...row.children].map((cell) => (cell.textContent ?? '').trim()),
  );

  const [header = [], ...body] = rows;

  return { header, rows: body, aligns };
}

/** Writes what the cells say back into the document, as one replacement of the block. */
function commit(view: EditorView, table: HTMLElement): boolean {
  const from = view.posAtDOM(table);
  const node = tableAt(view.state, from);
  if (!node) return false;

  const current = modelOf(view.state, node);
  if (!current) return false;

  const next = serialize(readDOM(table, current.aligns));
  const source = view.state.doc.sliceString(node.from, node.to);

  if (next === source) return false;

  view.dispatch({ changes: { from: node.from, to: node.to, insert: next } });

  return true;
}

function cellsOfDOM(table: HTMLElement): HTMLElement[] {
  return dataRows(table).flatMap((row) => [...row.children] as HTMLElement[]);
}

function focusCell(cell: HTMLElement | undefined): void {
  if (!cell) return;

  cell.focus();

  // Caret at the end of the cell rather than wherever the browser felt like putting it.
  const range = document.createRange();
  range.selectNodeContents(cell);
  range.collapse(false);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function onContextMenu(event: MouseEvent, view: EditorView, table: HTMLElement): void {
  const cell = (event.target as HTMLElement | null)?.closest('th, td');
  const handler = view.state.facet(tableMenu);
  if (!cell || !handler) return;

  event.preventDefault();
  event.stopPropagation();

  const rows = dataRows(table);
  const row = rows.indexOf(cell.parentElement as HTMLElement);

  handler(event, {
    view,
    table,
    row,
    column: (cell as HTMLTableCellElement).cellIndex,
    columns: rows[0]?.children.length ?? 1,
    // The header is not one of them.
    rows: rows.length - 1,
  });
}

function onKey(event: KeyboardEvent, view: EditorView, table: HTMLElement): void {
  const cells = cellsOfDOM(table);
  const at = cells.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;

  const columns = dataRows(table)[0]?.children.length ?? 1;

  // A cell is a contenteditable of its own, so the browser would answer ⌘Z with its own
  // idea of undo and the editor's history would sit there untouched.
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();

    commit(view, table);
    view.focus();
    (event.shiftKey ? redo : undo)(view);

    return;
  }

  if (event.key === 'Tab') {
    event.preventDefault();

    const next = event.shiftKey ? at - 1 : at + 1;

    // Tab off the last cell grows the table, which is how a table gets filled in without
    // ever going back to the menu.
    if (next >= cells.length) {
      appendRow(table, columns);
      commit(view, table);
      focusCell(cellsOfDOM(table)[at + 1]);
      return;
    }

    commit(view, table);
    focusCell(cellsOfDOM(table)[Math.max(0, next)]);
    return;
  }

  if (event.key === 'Enter') {
    event.preventDefault();

    const below = at + columns;

    if (below >= cells.length) {
      appendRow(table, columns);
      commit(view, table);
      focusCell(cellsOfDOM(table)[below]);
      return;
    }

    commit(view, table);
    focusCell(cellsOfDOM(table)[below]);
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();

    commit(view, table);
    view.focus();
    exitBelow(view, table);
  }
}

/**
 * Puts the caret below the table, with a blank line between.
 *
 * That blank line is not cosmetic. In GFM a non-empty line directly under a table is a
 * continuation of it, so a caret parked there turns the next thing written into another
 * row — the sentence after the table silently becomes part of it.
 */
function exitBelow(view: EditorView, table: HTMLElement): void {
  const node = tableAt(view.state, view.posAtDOM(table));
  if (!node) return;

  const doc = view.state.doc;

  if (node.to >= doc.length) {
    view.dispatch({
      changes: { from: doc.length, insert: '\n\n' },
      selection: { anchor: doc.length + 2 },
    });
    return;
  }

  const under = doc.lineAt(node.to + 1);

  if (under.text.trim() !== '') {
    // Something is already written there: push it down and land on it, now separated.
    view.dispatch({
      changes: { from: under.from, insert: '\n' },
      selection: { anchor: under.from + 1 },
    });
    return;
  }

  if (under.to >= doc.length) {
    view.dispatch({
      changes: { from: doc.length, insert: '\n' },
      selection: { anchor: doc.length + 1 },
    });
    return;
  }

  view.dispatch({ selection: { anchor: doc.lineAt(under.to + 1).from } });
}

/**
 * Adds a row to the DOM before the document knows about it. Doing it in this order means the
 * commit that follows finds a table of the new shape, so `updateDOM` can keep the element —
 * and with it the caret — instead of rebuilding it.
 */
function appendRow(table: HTMLElement, columns: number): void {
  const body = table.querySelector('tbody');
  if (!body) return;

  body.appendChild(rowDOM(Array.from({ length: columns }, () => ''), 'td', []));
}

function build(state: EditorState): DecorationSet {
  const found: Range<Decoration>[] = [];

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name !== 'Table') return undefined;

      const start = state.doc.lineAt(node.from);
      const end = state.doc.lineAt(node.to);

      // A block replacement has to cover whole lines. A table sharing a line with anything
      // else is malformed enough that leaving it as text is the honest answer.
      if (start.from !== node.from || end.to !== node.to) return false;

      const model = modelOf(state, node.node);
      if (!model) return false;

      found.push(
        Decoration.replace({
          block: true,
          widget: new TableWidget(model, state.doc.sliceString(node.from, node.to)),
        }).range(node.from, node.to),
      );

      return false;
    },
  });

  return Decoration.set(found, true);
}

const grid = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update: (value, tr) => (tr.docChanged ? build(tr.state) : value),
  provide: (field) => EditorView.decorations.from(field),
});

export const tableGrid: Extension = [grid];
