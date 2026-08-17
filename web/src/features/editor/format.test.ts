import { EditorSelection, EditorState, type TransactionSpec } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
  buildTable,
  changeCase,
  insertBlock,
  setHeading,
  toggleLinePrefix,
  toggleWrap,
  wrapSelection,
  wrapWikilink,
} from './format';

/**
 * The formatting verbs are the difference between "select a word, press *" adding markup and
 * replacing the word with an asterisk. These pin both halves of that: what the document ends
 * up saying, and where the selection is left — because a lost selection is what stops the
 * second `*` from reaching `**bold**`.
 */

function open(doc: string, anchor: number, head = anchor): EditorState {
  return EditorState.create({ doc, selection: EditorSelection.single(anchor, head) });
}

/** The document and selection a spec would produce, as `text` with the selection in `[]`. */
function applied(state: EditorState, spec: TransactionSpec | null): string {
  if (!spec) return '<null>';

  const next = state.update(spec).state;
  const { from, to } = next.selection.main;
  const doc = next.doc.toString();

  return `${doc.slice(0, from)}[${doc.slice(from, to)}]${doc.slice(to)}`;
}

describe('wrapping a selection', () => {
  it('puts the markers around the text instead of over it', () => {
    const state = open('a word here', 2, 6);

    expect(applied(state, wrapSelection(state, '**'))).toBe('a **[word]** here');
  });

  it('keeps the selection on the text, so a second press nests', () => {
    const once = open('a word here', 2, 6);
    const after = once.update(wrapSelection(once, '*') ?? {}).state;

    expect(applied(after, wrapSelection(after, '*'))).toBe('a **[word]** here');
  });

  it('does nothing without a selection', () => {
    expect(wrapSelection(open('a word', 3), '*')).toBeNull();
  });

  it('refuses to write into a read-only document', () => {
    const state = EditorState.create({
      doc: 'a word',
      selection: EditorSelection.single(2, 6),
      extensions: [EditorState.readOnly.of(true)],
    });

    expect(wrapSelection(state, '*')).toBeNull();
  });
});

describe('toggling a marker off', () => {
  it('strips markers that sit inside the selection', () => {
    const state = open('a **word** here', 2, 10);

    expect(applied(state, toggleWrap(state, '**'))).toBe('a [word] here');
  });

  it('strips markers that sit just outside it', () => {
    const state = open('a **word** here', 4, 8);

    expect(applied(state, toggleWrap(state, '**'))).toBe('a [word] here');
  });

  // The selection lands on the word rather than on the markers, so pressing the same key
  // again reads the wrapping back and takes it off.
  it('takes the word under a bare caret', () => {
    const state = open('a word here', 4);

    expect(applied(state, toggleWrap(state, '**'))).toBe('a **[word]** here');
  });

  it('inserts an empty pair when the caret has no word', () => {
    const state = open('a  b', 2);

    expect(applied(state, toggleWrap(state, '**'))).toBe('a **[]** b');
  });

  // A run longer than the marker is a different marker, not this one with room to spare.
  it('adds italics to bold rather than eating one of its asterisks', () => {
    const state = open('**word**', 2, 6);

    expect(applied(state, toggleWrap(state, '*'))).toBe('***[word]***');
  });

  it('still strips bold when the selection sits inside it', () => {
    const state = open('**word**', 2, 6);

    expect(applied(state, toggleWrap(state, '**'))).toBe('[word]');
  });

  it('adds rather than strips when only part of the selection is wrapped', () => {
    const state = EditorState.create({
      doc: '**a** b',
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(6, 7),
      ]),
      // Without this the state keeps only the main range and the case under test disappears.
      extensions: [EditorState.allowMultipleSelections.of(true)],
    });

    expect(state.update(toggleWrap(state, '**') ?? {}).state.doc.toString()).toBe('****a**** **b**');
  });
});

describe('line prefixes', () => {
  it('marks every line the selection touches', () => {
    const state = open('one\ntwo\nthree', 1, 9);

    expect(state.update(toggleLinePrefix(state, '- ') ?? {}).state.doc.toString()).toBe(
      '- one\n- two\n- three',
    );
  });

  it('removes the prefix when every line already has it', () => {
    const state = open('> one\n> two', 2, 8);

    expect(state.update(toggleLinePrefix(state, '> ') ?? {}).state.doc.toString()).toBe('one\ntwo');
  });

  it('adds it to all when only some lines have it', () => {
    const state = open('- one\ntwo', 1, 7);

    expect(state.update(toggleLinePrefix(state, '- ') ?? {}).state.doc.toString()).toBe(
      '- - one\n- two',
    );
  });

  it('replaces a heading rather than stacking another marker on it', () => {
    const state = open('# one', 2);

    expect(state.update(setHeading(state, 3) ?? {}).state.doc.toString()).toBe('### one');
  });

  it('strips the heading at level zero', () => {
    const state = open('### one', 5);

    expect(state.update(setHeading(state, 0) ?? {}).state.doc.toString()).toBe('one');
  });
});

describe('case', () => {
  const state = open('the QUICK brown fox. and then?', 0, 30);

  it.each([
    ['upper', 'THE QUICK BROWN FOX. AND THEN?'],
    ['lower', 'the quick brown fox. and then?'],
    ['title', 'The Quick Brown Fox. And Then?'],
    ['sentence', 'The quick brown fox. And then?'],
  ] as const)('%s', (mode, expected) => {
    expect(state.update(changeCase(state, mode) ?? {}).state.doc.toString()).toBe(expected);
  });

  it('keeps the selection on the text it just changed', () => {
    expect(applied(state, changeCase(state, 'upper'))).toBe('[THE QUICK BROWN FOX. AND THEN?]');
  });

  it('does nothing without a selection', () => {
    expect(changeCase(open('word', 2), 'upper')).toBeNull();
  });
});

describe('tables', () => {
  it('pads the columns to a common width', () => {
    expect(buildTable(1, 2)).toBe(
      ['| Column 1 | Column 2 |', '| -------- | -------- |', '|          |          |'].join('\n'),
    );
  });

  it('makes one header row plus the rows asked for', () => {
    expect(buildTable(3, 1).split('\n')).toHaveLength(5);
  });

  it('never builds a table with no cells', () => {
    expect(buildTable(0, 0)).toBe(buildTable(1, 1));
    expect(buildTable(-4, -1)).toBe(buildTable(1, 1));
  });
});

describe('inserting a block', () => {
  it('drops it in place on an empty line', () => {
    const state = open('a\n\nb', 2);

    expect(state.update(insertBlock(state, '---') ?? {}).state.doc.toString()).toBe('a\n---\nb');
  });

  it('breaks out of a line that already has text', () => {
    const state = open('word', 4);

    expect(state.update(insertBlock(state, '---') ?? {}).state.doc.toString()).toBe('word\n\n---');
  });

  it('leaves the caret after what it inserted', () => {
    const state = open('', 0);

    expect(applied(state, insertBlock(state, '---'))).toBe('---[]');
  });

  // A line directly under a table is another row of it in GFM, so the caret has to clear
  // the table by two lines or the next sentence typed becomes part of it.
  it('can leave the caret clear of the block, with a blank line between', () => {
    const state = open('', 0);

    expect(applied(state, insertBlock(state, '| a |', 'after'))).toBe('| a |\n\n[]');
  });
});

describe('wikilinks', () => {
  it('wraps the selection', () => {
    const state = open('see Roadmap now', 4, 11);

    expect(applied(state, wrapWikilink(state))).toBe('see [[[Roadmap]]] now');
  });

  it('opens an empty pair with the caret between the brackets', () => {
    const state = open('see ', 4);

    expect(applied(state, wrapWikilink(state))).toBe('see [[[]]]');
  });
});
