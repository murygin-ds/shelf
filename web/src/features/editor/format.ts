import {
  EditorSelection,
  type EditorState,
  type Line,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state';
import { EditorView, type Command, type KeyBinding } from '@codemirror/view';

import { m } from '@/i18n';

/**
 * The verbs behind the formatting keys and the right-click menu.
 *
 * Everything here is a pure function of a state: it returns the transaction it would like to
 * see applied, or null when the state gives it nothing to do. That is what lets these be
 * tested at all — the test environment is `node`, with no DOM for a view to attach to.
 *
 * The rule the whole file exists to enforce: markup goes *around* the selection. Typing `*`
 * over a selected word must produce `*word*`, not replace the word with an asterisk, and the
 * selection has to survive so a second `*` reaches `**word**`.
 */

export const MARKERS = {
  bold: '**',
  italic: '*',
  strike: '~~',
  code: '`',
} as const;

/** Symmetric markers that wrap a selection when typed. Brackets are `closeBrackets`' job. */
const WRAPPING = new Set(['*', '_', '~', '`']);

export function wrapSelection(state: EditorState, open: string, close = open): TransactionSpec | null {
  if (state.readOnly) return null;
  if (state.selection.ranges.every((range) => range.empty)) return null;

  return state.changeByRange((range) => {
    if (range.empty) return { range };

    return {
      changes: [
        { from: range.from, insert: open },
        { from: range.to, insert: close },
      ],
      // Both ends sit at or after the opening insert, so both move by the same amount and
      // the selection stays on the text rather than swallowing the markers.
      range: EditorSelection.range(range.anchor + open.length, range.head + open.length),
    };
  });
}

/**
 * Adds the marker, or takes it away when it is already there.
 *
 * Both spellings count as wrapped: the markers may sit inside the selection (`**word**`
 * selected whole) or just outside it (`word` selected between markers someone else typed).
 * A caret with no selection takes the word it is sitting in, which is what makes ⌘B useful
 * mid-sentence; with no word under it, the pair is inserted and the caret goes between them.
 */
export function toggleWrap(state: EditorState, marker: string): TransactionSpec | null {
  if (state.readOnly) return null;

  const { ranges, main } = state.selection;

  // A bare caret takes the word it is in. Widening every caret of a multi-range selection
  // would be the same idea, but two carets inside one word widen onto each other and
  // `changeByRange` may not be handed overlapping ranges — so that case keeps the carets.
  if (ranges.length === 1 && main.empty) {
    const word = state.wordAt(main.head);

    if (!word) {
      return {
        changes: { from: main.head, insert: marker + marker },
        selection: EditorSelection.cursor(main.head + marker.length),
      };
    }

    const step = wrapping(state, word, marker) === 'none' ? added(word, marker) : removed(state, word, marker);

    return { changes: step.changes, selection: EditorSelection.create([step.range]) };
  }

  const on = ranges.every((range) => range.empty || wrapping(state, range, marker) !== 'none');

  return state.changeByRange((range) =>
    range.empty ? { range } : on ? removed(state, range, marker) : added(range, marker),
  );
}

interface Step {
  changes: { from: number; to?: number; insert?: string }[];
  range: SelectionRange;
}

function added(range: SelectionRange, marker: string): Step {
  return {
    changes: [
      { from: range.from, insert: marker },
      { from: range.to, insert: marker },
    ],
    range: EditorSelection.range(range.anchor + marker.length, range.head + marker.length),
  };
}

function removed(state: EditorState, range: SelectionRange, marker: string): Step {
  const width = marker.length;
  const where = wrapping(state, range, marker);
  const forward = range.anchor <= range.head;

  if (where === 'inside') {
    const from = range.from;
    const to = range.to - width * 2;

    return {
      changes: [
        { from: range.from, to: range.from + width },
        { from: range.to - width, to: range.to },
      ],
      range: forward ? EditorSelection.range(from, to) : EditorSelection.range(to, from),
    };
  }

  if (where === 'around') {
    const from = range.from - width;
    const to = range.to - width;

    return {
      changes: [
        { from: range.from - width, to: range.from },
        { from: range.to, to: range.to + width },
      ],
      range: forward ? EditorSelection.range(from, to) : EditorSelection.range(to, from),
    };
  }

  return { changes: [], range };
}

type Wrapping = 'none' | 'inside' | 'around';

/**
 * The run of marker characters has to be exactly as long as the marker, not merely as long.
 * `**bold**` starts with an asterisk, but for ⌘I that is not italics to take off — it is bold
 * to put italics around, and the answer is `***bold***`.
 */
function wrapping(state: EditorState, range: SelectionRange, marker: string): Wrapping {
  const width = marker.length;
  const char = marker[0] ?? '';
  const inner = state.doc.sliceString(range.from, range.to);

  if (inner.length >= width * 2 && lead(inner, char) === width && trail(inner, char) === width) {
    return 'inside';
  }

  const before = run(state, range.from, -1, char);
  const after = run(state, range.to, 1, char);

  return before === width && after === width ? 'around' : 'none';
}

function lead(text: string, char: string): number {
  let count = 0;

  while (count < text.length && text[count] === char) count += 1;

  return count;
}

function trail(text: string, char: string): number {
  let count = 0;

  while (count < text.length && text[text.length - 1 - count] === char) count += 1;

  return count;
}

function run(state: EditorState, at: number, dir: 1 | -1, char: string): number {
  let count = 0;
  let pos = at;

  for (;;) {
    const next = dir < 0 ? pos - 1 : pos;

    if (next < 0 || next >= state.doc.length) break;
    if (state.doc.sliceString(next, next + 1) !== char) break;

    count += 1;
    pos += dir;
  }

  return count;
}

/** `#`, `>`, `- `, `- [ ] ` — added to every touched line, removed when they all have it. */
export function toggleLinePrefix(state: EditorState, prefix: string): TransactionSpec | null {
  if (state.readOnly) return null;

  const lines = touchedLines(state);
  if (!lines.length) return null;

  const on = lines.every((line) => line.text.startsWith(prefix));

  return {
    changes: lines.map((line) =>
      on
        ? { from: line.from, to: line.from + prefix.length }
        : { from: line.from, insert: prefix },
    ),
  };
}

/** Level 0 strips the heading; anything else replaces whatever marker the line already has. */
export function setHeading(state: EditorState, level: number): TransactionSpec | null {
  if (state.readOnly) return null;

  const lines = touchedLines(state);
  if (!lines.length) return null;

  const prefix = level > 0 ? `${'#'.repeat(level)} ` : '';

  return {
    changes: lines.map((line) => {
      const existing = /^#{1,6} +/.exec(line.text)?.[0] ?? '';

      return { from: line.from, to: line.from + existing.length, insert: prefix };
    }),
  };
}

export type CaseMode = 'upper' | 'lower' | 'title' | 'sentence';

export function changeCase(state: EditorState, mode: CaseMode): TransactionSpec | null {
  if (state.readOnly) return null;
  if (state.selection.ranges.every((range) => range.empty)) return null;

  return state.changeByRange((range) => {
    if (range.empty) return { range };

    const text = recase(state.doc.sliceString(range.from, range.to), mode);

    return {
      changes: { from: range.from, to: range.to, insert: text },
      range: EditorSelection.range(range.anchor, range.head),
    };
  });
}

function recase(text: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      // Word boundary rather than a split on spaces: hyphenated and quoted words each get
      // their own capital, and every other character keeps its position in the string.
      return text.toLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_, lead: string, first: string) =>
        lead + first.toUpperCase(),
      );
    default:
      return text
        .toLowerCase()
        .replace(/(^\s*|[.!?]\s+)(\p{L})/gu, (_, lead: string, first: string) => lead + first.toUpperCase());
  }
}

/**
 * A GFM table whose columns are padded to a common width, so the source stays readable
 * while it is being filled in — the live preview styles these rows but does not lay them out.
 */
export function buildTable(rows: number, cols: number): string {
  const columns = Math.max(1, Math.trunc(cols));
  const body = Math.max(1, Math.trunc(rows));

  const headers = Array.from({ length: columns }, (_, index) => m.editor.tableColumn(index + 1));
  const widths = headers.map((header) => header.length);

  const row = (cells: string[]) =>
    `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(' | ')} |`;

  return [
    row(headers),
    `| ${widths.map((width) => '-'.repeat(width)).join(' | ')} |`,
    ...Array.from({ length: body }, () => row(headers.map(() => ''))),
  ].join('\n');
}

/**
 * Puts a block on lines of its own, whatever the caret was sitting in the middle of.
 *
 * `caret: 'after'` leaves it two lines below instead of at the end of the block. That is
 * what a table wants, for two reasons: the caret inside one would keep it showing its pipes,
 * and in GFM a non-empty line directly under a table is another row of it — so landing on
 * the line immediately below would turn the next sentence into part of the table.
 */
export function insertBlock(
  state: EditorState,
  text: string,
  caret: 'inside' | 'after' = 'inside',
): TransactionSpec | null {
  if (state.readOnly) return null;

  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);

  const before = line.text.slice(0, range.head - line.from).trim() ? '\n\n' : '';
  const after = line.text.slice(range.head - line.from).trim() ? '\n\n' : '';
  const tail = caret === 'after' ? '\n\n' : '';
  const insert = `${before}${text}${tail}${after}`;

  return {
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.cursor(range.from + before.length + text.length + tail.length),
  };
}

/** `[[Title]]` around the selection, or an empty pair with the caret ready to type into. */
export function wrapWikilink(state: EditorState): TransactionSpec | null {
  if (state.readOnly) return null;

  if (state.selection.ranges.every((range) => range.empty)) {
    return state.changeByRange((range) => ({
      changes: { from: range.head, insert: '[[]]' },
      range: EditorSelection.cursor(range.head + 2),
    }));
  }

  return wrapSelection(state, '[[', ']]');
}

function touchedLines(state: EditorState): Line[] {
  const lines: Line[] = [];

  for (const range of state.selection.ranges) {
    let pos = range.from;

    while (pos <= range.to) {
      const line = state.doc.lineAt(pos);

      // Multiple ranges on one line must not prefix it twice.
      if (!lines.some((seen) => seen.from === line.from)) lines.push(line);

      pos = line.to + 1;
    }
  }

  return lines;
}

export function command(build: (state: EditorState) => TransactionSpec | null): Command {
  return (view) => {
    const spec = build(view.state);
    if (!spec) return false;

    view.dispatch(spec);

    return true;
  };
}

/**
 * Typing a marker over a selection wraps it.
 *
 * `closeBrackets` would do this for a character it knows, but it also auto-closes that
 * character when nothing is selected — and a lone `*` turning into `**` mid-sentence is not
 * what anyone typing prose wants. So the symmetric markers are handled here, on the one case
 * that matters, and brackets and quotes are left to `closeBrackets`.
 */
export const wrapOnType = EditorView.inputHandler.of((view, from, to, text) => {
  if (!WRAPPING.has(text)) return false;

  const main = view.state.selection.main;

  // One typed character replacing exactly the selection. A paste and the commit of an IME
  // composition arrive here too, and neither of those is someone asking for emphasis.
  if (view.composing || from !== main.from || to !== main.to) return false;
  if (view.state.selection.ranges.every((range) => range.empty)) return false;

  const spec = wrapSelection(view.state, text);
  if (!spec) return false;

  view.dispatch({ ...spec, scrollIntoView: true, userEvent: 'input.type' });

  return true;
});

export const formatKeymap: readonly KeyBinding[] = [
  { key: 'Mod-b', run: command((state) => toggleWrap(state, MARKERS.bold)) },
  { key: 'Mod-i', run: command((state) => toggleWrap(state, MARKERS.italic)) },
  { key: 'Mod-Shift-x', run: command((state) => toggleWrap(state, MARKERS.strike)) },
  { key: 'Mod-e', run: command((state) => toggleWrap(state, MARKERS.code)) },
];
