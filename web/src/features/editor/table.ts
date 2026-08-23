import { redo, undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import {
  EditorState,
  Facet,
  StateField,
  type Extension,
  type Range,
  type TransactionSpec,
} from '@codemirror/state';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

import { resolveTarget } from '@/lib/wikilinks';

import { EMPTY_CONTEXT, openWikilink, vaultContext } from './context';
import { inlineSpans, isPlain, sourceOffset, type InlineSpan } from './inline';

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
 *
 * The pipes being gone is also why a cell renders its own markdown: the rest of the note can
 * fall back on the reader seeing the markers, and a cell cannot. So a cell has two faces —
 * the markdown it holds, kept on the element, and the text that stands in for it — and the
 * caret arriving is what brings the first one back, exactly as it does for a heading.
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
function tableAt(state: EditorState, pos: number, side: -1 | 1 = 1): SyntaxNode | null {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side);

  while (node && node.name !== 'Table') node = node.parent;

  return node;
}

/**
 * The table the document ends on, if it ends on one.
 *
 * A block replacement covering the last line leaves the position after it with no DOM of its
 * own. The caret can still be moved there, and CodeMirror will report it there, but the
 * browser draws it in the nearest editable spot it can find — a line above the table — and
 * that is where the next keystroke is written. A lone blank line under the table is no way
 * out either: a caret on it writes another row.
 */
export function trailingTable(state: EditorState): SyntaxNode | null {
  const last = state.doc.lineAt(state.doc.length);
  const end = last.from > 0 && last.text.trim() === '' ? last.from - 1 : last.to;

  const node = tableAt(state, end, -1);

  return node && node.to >= end ? node : null;
}

/**
 * Whether `pos` sits on the blank line a table ends against — the line markdown reads as one
 * more row of it the moment anything is written there.
 */
export function rowUnderTable(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  if (line.from === 0 || line.text.trim() !== '') return false;

  const node = tableAt(state, line.from - 1, -1);

  return !!node && node.to === line.from - 1;
}

class TableWidget extends WidgetType {
  constructor(
    private readonly model: TableModel,
    private readonly source: string,
    /**
     * Whether the cells take the caret.
     *
     * It has to be part of the widget rather than read at each keystroke: a cell is a
     * `contenteditable` of its own inside the editor's, so `EditorView.editable` — which is
     * what read-only drops — says nothing about it. Without this the grid stays writable
     * while the prose around it has stopped being.
     */
    private readonly readOnly: boolean,
    /**
     * What a `[[link]]` in a cell resolves against. Carried so that a note appearing under
     * a name the table already links to redraws the link, which no keystroke would.
     */
    private readonly targets: Targets,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return (
      other.source === this.source &&
      other.readOnly === this.readOnly &&
      other.targets === this.targets
    );
  }

  /**
   * The `<table>` goes inside a box of its own rather than being the widget itself, because
   * the air around it has to be padding. CodeMirror measures a block widget with
   * `getBoundingClientRect`, which does not see margins: spacing the grid with one would
   * leave the height map short by that much for every table above a line, and a click on the
   * lower part of that line would resolve to the block below it.
   */
  override toDOM(view: EditorView): HTMLElement {
    const table = document.createElement('div');
    table.className = 'cm-md-grid';
    // The widget sits inside the editor's own contenteditable, so it has to opt out of it
    // explicitly; the cells then opt back in one at a time.
    table.contentEditable = 'false';

    const grid = table.appendChild(document.createElement('table'));
    const editable = !this.readOnly;

    const head = grid.appendChild(document.createElement('thead'));
    head.appendChild(rowDOM(this.model.header, 'th', this.model.aligns, editable, this.targets));

    const body = grid.appendChild(document.createElement('tbody'));
    for (const row of this.model.rows) {
      body.appendChild(rowDOM(row, 'td', this.model.aligns, editable, this.targets));
    }

    table.addEventListener('keydown', (event) => onKey(event, view, table));
    table.addEventListener('contextmenu', (event) => onContextMenu(event, view, table));
    table.addEventListener('mousedown', (event) => onDown(event, view));
    table.addEventListener('click', (event) => onClick(event, view));

    // Reached by the keyboard as well as by the pointer, so the swap to markdown lives here
    // rather than with the click that usually causes it.
    table.addEventListener('focusin', (event) => {
      const cell = cellOf(event.target);

      if (cell && !view.state.readOnly) {
        paint(cell, cell.dataset.md ?? '', 'source', targetsOf(view));
      }
    });

    table.addEventListener('focusout', (event) => {
      const cell = cellOf(event.target);

      queueMicrotask(() => {
        // Whatever was typed is only in the element until now; the cell is about to stop
        // showing it. `sourceOf` rather than the element, because a commit further down the
        // same keystroke may already have painted this cell back.
        if (cell && document.activeElement !== cell) {
          paint(cell, sourceOf(cell), 'shown', targetsOf(view));
        }

        // A blur that lands on another cell of the same table is navigation, not an exit.
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
        // The one thing that is set even on the focused cell: read-only arriving while the
        // caret is in a cell is exactly the case that has to take the caret away.
        cell.contentEditable = String(!this.readOnly);

        // Otherwise never the focused one: it holds the caret, and rewriting its text moves it.
        if (cell === document.activeElement) return;

        paint(cell, texts[column] ?? '', 'shown', this.targets);

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
  if (view.state.readOnly) return;

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
  if (ref.view.state.readOnly) return;

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

function rowDOM(
  cells: string[],
  tag: 'th' | 'td',
  aligns: Align[],
  editable: boolean,
  targets: Targets,
): HTMLElement {
  const row = document.createElement('tr');

  cells.forEach((text, index) => {
    const cell = row.appendChild(document.createElement(tag));

    paint(cell, text, 'shown', targets);
    cell.contentEditable = String(editable);
    cell.spellcheck = false;
    cell.style.textAlign = aligns[index] ?? 'left';
  });

  return row;
}

/** What a vault's `[[links]]` resolve against, which is the facet's map and its identity. */
type Targets = ReadonlyMap<string, number>;

function targetsOf(view: EditorView): Targets {
  return view.state.facet(vaultContext).targets;
}

/**
 * Puts one of a cell's two faces on screen, and keeps the markdown on the element either way
 * — `bold` is not something `**bold**` can be read back out of, and the document is what the
 * cells are written to.
 */
function paint(cell: HTMLElement, md: string, face: 'source' | 'shown', targets: Targets): void {
  cell.dataset.md = md;
  cell.dataset.face = face;

  if (face === 'source') {
    setText(cell, md);

    return;
  }

  const spans = inlineSpans(md);

  // Nothing to render, which is what nearly every cell is: one text node, and no rebuilding
  // of it on keystrokes landing elsewhere in the table.
  if (spans.every(isPlain)) {
    setText(cell, spans.map((span) => span.text).join(''));

    return;
  }

  cell.replaceChildren(...spans.map((span) => spanDOM(span, targets)));
}

/**
 * The cell as one text node. Left alone when it already is one saying that, because the
 * caret is in it — but a cell that still holds the elements of a previous render has to be
 * rebuilt even when they happen to spell the same thing.
 */
function setText(cell: HTMLElement, value: string): void {
  const lone = cell.firstChild instanceof Text && cell.firstChild === cell.lastChild;

  if (!lone || cell.textContent !== value) cell.textContent = value;
}

/**
 * One span as elements. Built rather than parsed from a string of HTML: the reader's own
 * text only ever becomes a text node, so a cell holding `<script>` holds those characters.
 *
 * The classes are live preview's, so a bold word reads the same inside a table as outside.
 */
function spanDOM(span: InlineSpan, targets: Targets): Node {
  let node: Node = document.createTextNode(span.text);

  if (span.code) node = wrap('code', 'cm-md-code', node);

  if (span.wiki !== undefined) {
    const known = resolveTarget(span.wiki, targets) !== undefined;
    const link = wrap('span', known ? 'cm-md-wiki' : 'cm-md-wiki cm-md-wiki-missing', node);

    // Resolved again when it is pressed: where a target leads is the vault's business, and by
    // then the vault may hold the note this one is still missing.
    link.dataset.link = span.wiki;
    node = link;
  } else if (span.link) {
    node = wrap('span', 'cm-md-link', node);
  }

  if (span.strike) node = wrap('s', 'cm-md-strike', node);
  if (span.em) node = wrap('em', 'cm-md-em', node);
  if (span.strong) node = wrap('strong', 'cm-md-strong', node);

  return node;
}

function wrap(tag: string, cls: string, child: Node): HTMLElement {
  const element = document.createElement(tag);

  element.className = cls;
  element.appendChild(child);

  return element;
}

function readDOM(table: HTMLElement, aligns: Align[]): TableModel {
  const rows = dataRows(table).map((row) =>
    [...row.children].map((cell) => sourceOf(cell as HTMLElement)),
  );

  const [header = [], ...body] = rows;

  return { header, rows: body, aligns };
}

/**
 * The markdown a cell holds.
 *
 * A cell showing its source is the one being typed into, so there the element is the truth
 * and what it was last painted with is already stale. Everywhere else it is the other way
 * round: the element says `bold`, and `**bold**` is what the document has to keep.
 */
function sourceOf(cell: HTMLElement): string {
  const md = cell.dataset.face === 'source' ? cell.textContent : cell.dataset.md;

  return (md ?? cell.textContent ?? '').trim();
}

/**
 * Writes what the cells say back into the document, as one replacement of the block.
 *
 * This is the only way a grid reaches the document, so it is where read-only is enforced:
 * `EditorState.readOnly` is consulted by editing commands, and a dispatch of plain changes
 * is not one of them.
 */
function commit(view: EditorView, table: HTMLElement): boolean {
  if (view.state.readOnly) return false;

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

function cellOf(target: EventTarget | null): HTMLElement | null {
  return (target as HTMLElement | null)?.closest?.('th, td') ?? null;
}

/** The wikilink target a point in the grid belongs to, if it belongs to one. */
function linkOf(target: EventTarget | null): string | undefined {
  const link = (target as HTMLElement | null)?.closest?.('[data-link]');

  return link instanceof HTMLElement ? link.dataset.link : undefined;
}

function follow(view: EditorView, target: string, event: MouseEvent): void {
  event.preventDefault();
  view.state.facet(openWikilink)?.(target, event.metaKey || event.ctrlKey ? 'tab' : 'here');
}

/**
 * A press inside the grid.
 *
 * The caret is placed here rather than by the browser, because the press is also what brings
 * a cell's markdown back: the browser would measure the click against the rendered text and
 * then land the caret in text that has since grown a pair of asterisks. `sourceOffset` maps
 * the one to the other, so the caret ends up on the character that was actually clicked.
 */
function onDown(event: MouseEvent, view: EditorView): void {
  const link = linkOf(event.target);

  // Middle-click opens a link in another tab and never places a caret. Swallowing it also
  // keeps the browser from starting its own autoscroll on the way to the click.
  if (event.button === 1) {
    if (link !== undefined) follow(view, link, event);

    return;
  }

  // While reading, a press is the start of a selection and the link is followed on the click.
  if (event.button !== 0 || view.state.readOnly) return;

  // A link that leads somewhere is followed; one that leads nowhere is text to be fixed, and
  // its cursor says as much. Taken on the press rather than on the click because the swap
  // below removes the very element a click would be reported on.
  if (link !== undefined && resolveTarget(link, targetsOf(view)) !== undefined) {
    follow(view, link, event);

    return;
  }

  const cell = cellOf(event.target);
  if (!cell) return;

  const md = cell.dataset.md ?? '';

  // Nothing was rendered away, so the browser's own answer is already the right one.
  if (cell.dataset.face === 'source' || cell.textContent === md) return;

  const at = sourceOffset(inlineSpans(md), offsetIn(cell, caretAt(event.clientX, event.clientY)));

  event.preventDefault();
  paint(cell, md, 'source', targetsOf(view));
  focusCell(cell, at);
}

/** Following a link while reading, where no cell takes the caret and nothing is swapped. */
function onClick(event: MouseEvent, view: EditorView): void {
  if (event.button !== 0 || !view.state.readOnly) return;

  const link = linkOf(event.target);
  if (link !== undefined) follow(view, link, event);
}

interface CaretPoint {
  node: Node;
  offset: number;
}

/**
 * The character a point lands on. Two spellings of one question — the older one WebKit's, the
 * newer one the standard's — and which of them a browser has is not something to guess at.
 */
function caretAt(x: number, y: number): CaretPoint | null {
  const range = document.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };

  const position = document.caretPositionFromPoint?.(x, y);

  return position ? { node: position.offsetNode, offset: position.offset } : null;
}

/** Where a point falls in a cell's rendered text, counted across the elements it is made of. */
function offsetIn(cell: HTMLElement, at: CaretPoint | null): number {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let seen = 0;

  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if (at && text === at.node) return seen + at.offset;

    seen += text.textContent?.length ?? 0;
  }

  return seen;
}

function focusCell(cell: HTMLElement | undefined, at?: number): void {
  if (!cell) return;

  cell.focus();

  // The markdown is back on screen by now — focus is what brings it — so the offset the
  // caller asked for is an offset into it.
  const text = cell.firstChild;
  const range = document.createRange();

  if (at !== undefined && text instanceof Text) {
    range.setStart(text, Math.max(0, Math.min(at, text.length)));
    range.collapse(true);
  } else {
    // Otherwise the end of the cell, rather than wherever the browser felt like putting it.
    range.selectNodeContents(cell);
    range.collapse(false);
  }

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function onContextMenu(event: MouseEvent, view: EditorView, table: HTMLElement): void {
  const cell = cellOf(event.target);
  const handler = view.state.facet(tableMenu);
  if (!cell || !handler) return;

  // Every verb this menu has writes. Left alone, the event reaches the editor's own handler
  // and the body menu opens over the grid, which is the right answer while reading.
  if (view.state.readOnly) return;

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

  // Down out of the bottom row and up out of the header are the way out of a table that ends
  // or opens a note, where the document has no line on that side to reach for.
  if (event.key === 'ArrowDown' && at + columns >= cells.length) {
    event.preventDefault();

    exit(view, table, 'below');
    return;
  }

  if (event.key === 'ArrowUp' && at < columns) {
    event.preventDefault();

    exit(view, table, 'above');
    return;
  }

  if (event.key === 'Escape') {
    event.preventDefault();

    exit(view, table, 'below');
  }
}

/**
 * Puts the caret below the table, with a blank line between.
 *
 * That blank line is not cosmetic. In GFM a non-empty line directly under a table is a
 * continuation of it, so a caret parked there turns the next thing written into another
 * row — the sentence after the table silently becomes part of it.
 */
export function exitBelow(state: EditorState, node: SyntaxNode): TransactionSpec {
  const doc = state.doc;

  if (node.to >= doc.length) {
    return {
      changes: { from: doc.length, insert: '\n\n' },
      selection: { anchor: doc.length + 2 },
      scrollIntoView: true,
    };
  }

  const under = doc.lineAt(node.to + 1);

  // Something is already written there: push it down and land on it, now separated.
  if (under.text.trim() !== '') {
    return {
      changes: { from: under.from, insert: '\n' },
      selection: { anchor: under.from + 1 },
      scrollIntoView: true,
    };
  }

  if (under.to >= doc.length) {
    return {
      changes: { from: doc.length, insert: '\n' },
      selection: { anchor: doc.length + 1 },
      scrollIntoView: true,
    };
  }

  return { selection: { anchor: doc.lineAt(under.to + 1).from }, scrollIntoView: true };
}

/**
 * The same upwards, for the table a note opens with — which is the same trap read the other
 * way round, with the added twist that there is no empty page above the first block to click
 * on at all.
 */
export function exitAbove(state: EditorState, node: SyntaxNode): TransactionSpec {
  if (node.from === 0) {
    return { changes: { from: 0, insert: '\n\n' }, selection: { anchor: 0 }, scrollIntoView: true };
  }

  const over = state.doc.lineAt(node.from - 1);

  // A heading sits directly above the table it introduces; landing on it would put the caret
  // in someone else's line rather than in a line of one's own.
  if (over.text.trim() !== '') {
    return {
      changes: { from: over.to, insert: '\n' },
      selection: { anchor: over.to + 1 },
      scrollIntoView: true,
    };
  }

  return { selection: { anchor: over.from }, scrollIntoView: true };
}

/** Leaves the grid for the document around it, taking whatever is half-typed along. */
function exit(view: EditorView, table: HTMLElement, where: 'above' | 'below'): void {
  commit(view, table);
  view.focus();

  const node = tableAt(view.state, view.posAtDOM(table));
  if (!node) return;

  view.dispatch(where === 'below' ? exitBelow(view.state, node) : exitAbove(view.state, node));
}

/**
 * Adds a row to the DOM before the document knows about it. Doing it in this order means the
 * commit that follows finds a table of the new shape, so `updateDOM` can keep the element —
 * and with it the caret — instead of rebuilding it.
 */
function appendRow(table: HTMLElement, columns: number): void {
  const body = table.querySelector('tbody');
  if (!body) return;

  // Only ever reached from a keystroke inside a cell, which is to say from a grid that
  // takes the caret in the first place.
  body.appendChild(
    rowDOM(Array.from({ length: columns }, () => ''), 'td', [], true, EMPTY_CONTEXT.targets),
  );
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
          widget: new TableWidget(
            model,
            state.doc.sliceString(node.from, node.to),
            state.readOnly,
            state.facet(vaultContext).targets,
          ),
        }).range(node.from, node.to),
      );

      return false;
    },
  });

  return Decoration.set(found, true);
}

const grid = StateField.define<DecorationSet>({
  create: (state) => build(state),
  // Rebuilt when the mode changes as well as when the text does: read-only is reconfigured
  // into a live editor — the note on screen can become unwritable without a keystroke — and
  // the widgets carry it. The vault around the note is the third of those: a note created
  // under a name a cell links to turns that link from missing into one that leads somewhere.
  update: (value, tr) =>
    tr.docChanged ||
    tr.startState.readOnly !== tr.state.readOnly ||
    tr.startState.facet(vaultContext) !== tr.state.facet(vaultContext)
      ? build(tr.state)
      : value,
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * The empty page under a trailing table, turned into the line that is missing there.
 *
 * Clicking below the last block is how a paragraph gets added to the end of a note, and a
 * trailing table is the one thing that breaks it: the click resolves to the position after
 * the table, which no caret can occupy, and the typing lands somewhere above instead.
 */
const groundBelow = EditorView.domEventHandlers({
  mousedown: (event, view) => {
    if (event.button !== 0 || view.state.readOnly) return false;

    const node = trailingTable(view.state);
    if (!node) return false;

    // Strictly under the grid: a click on the table itself belongs to the cell it hit.
    const rect = view.coordsAtPos(node.to);
    if (!rect || event.clientY <= rect.bottom) return false;

    event.preventDefault();
    view.dispatch(exitBelow(view.state, node));
    view.focus();

    return true;
  },
});

/**
 * Keeps what is written under a table out of it.
 *
 * In GFM the line a table ends against is one more row of it as soon as it holds anything, so
 * a sentence typed on the blank line below the grid does not appear under the table — it
 * appears inside it, as a row. Nothing on screen says why, because the pipes it was written
 * between are never shown. So the first thing written there opens a line of its own first.
 */
const roomUnder = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !tr.isUserEvent('input')) return tr;

  let at: number | null = null;

  tr.changes.iterChanges((fromA, _toA, fromB, _toB, inserted) => {
    // A leading newline already is the blank line; there is nothing to make room for.
    if (at !== null || inserted.line(1).text === '') return;
    if (!rowUnderTable(tr.startState, fromA)) return;

    at = tr.state.doc.lineAt(fromB).from;
  });

  return at === null ? tr : [tr, { changes: { from: at, insert: '\n' }, sequential: true }];
});

export const tableGrid: Extension = [grid, groundBelow, roomUnder];
