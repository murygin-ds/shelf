import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { describe, expect, it } from 'vitest';

import { noteLanguage } from './language';
import {
  alignsOf,
  exitAbove,
  exitBelow,
  serialize,
  tableGrid,
  trailingTable,
  type TableModel,
} from './table';

/**
 * Nobody sees this markdown while they are editing — the grid is what is on screen — which
 * is exactly why it has to be right: it is what the note actually holds, what syncs, and
 * what another editor will open.
 */

function model(partial: Partial<TableModel>): TableModel {
  return { header: [], rows: [], aligns: [], ...partial };
}

describe('writing a table back out', () => {
  it('pads the columns to a common width', () => {
    const text = serialize(
      model({ header: ['a', 'long header'], rows: [['x', 'y']], aligns: ['left', 'left'] }),
    );

    expect(text.split('\n')).toEqual([
      '| a   | long header |',
      '| --- | ----------- |',
      '| x   | y           |',
    ]);
  });

  it('keeps the alignment markers', () => {
    const text = serialize(
      model({ header: ['a', 'b', 'c'], aligns: ['left', 'center', 'right'] }),
    );

    expect(text.split('\n')[1]).toBe('| --- | :-: | --: |');
  });

  it('squares off a ragged table against the widest row', () => {
    const text = serialize(model({ header: ['a'], rows: [['x', 'y']] }));

    expect(text.split('\n')).toEqual(['| a   |     |', '| --- | --- |', '| x   | y   |']);
  });

  // A pipe typed into a cell would end the cell when the file is read back.
  it('escapes a pipe typed into a cell', () => {
    expect(serialize(model({ header: ['a|b'] }))).toContain('a\\|b');
  });

  // Cells are one line each; a pasted newline would split the row into two.
  it('flattens a newline pasted into a cell', () => {
    expect(serialize(model({ header: ['one\ntwo'] }))).toContain('one two');
  });

  it('survives a table with nothing in it', () => {
    expect(serialize(model({ header: [''], rows: [['']] })).split('\n')).toEqual([
      '|     |',
      '| --- |',
      '|     |',
    ]);
  });
});

describe('reading the alignment row', () => {
  it.each([
    ['| --- | :-- | --: | :-: |', ['left', 'left', 'right', 'center']],
    ['|---|---|', ['left', 'left']],
  ])('%s', (text, expected) => {
    expect(alignsOf(text)).toEqual(expected);
  });
});

const TABLE = ['| a   | b   |', '| --- | --- |', '| x   | y   |'].join('\n');

function open(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [noteLanguage] });
}

function tableIn(state: EditorState): SyntaxNode {
  const node = syntaxTree(state).topNode.getChild('Table');
  if (!node) throw new Error('the fixture has no table in it');

  return node;
}

/** The document the move leaves behind, with the caret written as `|`. */
function exit(doc: string, where: 'above' | 'below'): string {
  const state = open(doc);
  const node = tableIn(state);

  const next = state.update(where === 'below' ? exitBelow(state, node) : exitAbove(state, node)).state;
  const head = next.selection.main.head;

  return `${next.doc.sliceString(0, head)}|${next.doc.sliceString(head)}`;
}

/**
 * The grid is a block replacement, so a table at either end of the note leaves no line there
 * to click on — and the position past it holds no caret. These pin the ways out.
 */
describe('the table a note ends on', () => {
  it('is what the document ends with', () => {
    expect(trailingTable(open(`Before.\n\n${TABLE}`))).not.toBeNull();
  });

  it.each([
    ['a paragraph under it', `${TABLE}\n\nAfter.`],
    ['a blank line already under it', `${TABLE}\n\n`],
    ['no table at all', 'Just a note.'],
  ])('is not %s', (_, doc) => {
    expect(trailingTable(open(doc))).toBeNull();
  });

  // A caret on that line writes a row rather than a sentence, so it is not a way out either.
  it('is a table with a single newline after it', () => {
    expect(trailingTable(open(`${TABLE}\n`))).not.toBeNull();
  });
});

describe('leaving a table downwards', () => {
  it('opens a separated line when the note ends there', () => {
    expect(exit(TABLE, 'below')).toBe(`${TABLE}\n\n|`);
  });

  it('separates the caret from the table when only a newline follows', () => {
    expect(exit(`${TABLE}\n`, 'below')).toBe(`${TABLE}\n\n|`);
  });

  // A block that ends the table without a blank line — a plain sentence there would be one
  // more row of it, but a heading breaks out on its own.
  it('pushes down the block that ends it', () => {
    expect(exit(`${TABLE}\n# Next`, 'below')).toBe(`${TABLE}\n\n|# Next`);
  });

  it('lands on the blank line that is already there', () => {
    expect(exit(`${TABLE}\n\nAfter.`, 'below')).toBe(`${TABLE}\n\n|After.`);
  });
});

/** What writing `text` at `at` leaves behind, once the editor's filters have had it. */
function typed(doc: string, at: number, text: string, userEvent: string | null = 'input.type'): string {
  const state = EditorState.create({ doc, extensions: [noteLanguage, tableGrid] });
  const changes = { from: at, insert: text };

  // `null` is a change nobody typed: no user event on it at all.
  return state
    .update(userEvent === null ? { changes } : { changes, userEvent })
    .state.doc.toString();
}

/** The blank line a table ends against, which is where a sentence goes to become a row. */
const UNDER = TABLE.length + 1;

describe('writing on the line a table ends against', () => {
  it('opens a line of its own for it', () => {
    expect(typed(`${TABLE}\n\ntail`, UNDER, 'hello')).toBe(`${TABLE}\n\nhello\ntail`);
  });

  it('leaves a newline typed there alone', () => {
    expect(typed(`${TABLE}\n\ntail`, UNDER, '\n')).toBe(`${TABLE}\n\n\ntail`);
  });

  it('separates a paste the same way', () => {
    expect(typed(`${TABLE}\n\ntail`, UNDER, 'hello', 'input.paste')).toBe(
      `${TABLE}\n\nhello\ntail`,
    );
  });

  // Somebody else's keystroke, or a body pulled from the server: reshaping those would be
  // rewriting what they wrote rather than what this person is typing.
  it('leaves a change nobody typed alone', () => {
    expect(typed(`${TABLE}\n\ntail`, UNDER, 'hello', null)).toBe(`${TABLE}\nhello\ntail`);
  });
});

describe('writing anywhere else', () => {
  it('is untouched a blank line further down', () => {
    expect(typed(`${TABLE}\n\n\ntail`, UNDER + 1, 'ok')).toBe(`${TABLE}\n\nok\ntail`);
  });

  it('is untouched under something that is not a table', () => {
    expect(typed('one\n\nthree', 4, 'two')).toBe('one\ntwo\nthree');
  });
});

describe('leaving a table upwards', () => {
  it('opens a separated line when the note starts there', () => {
    expect(exit(TABLE, 'above')).toBe(`|\n\n${TABLE}`);
  });

  it('opens a line under the heading it belongs to', () => {
    expect(exit(`# Title\n${TABLE}`, 'above')).toBe(`# Title\n|\n${TABLE}`);
  });

  it('lands on the blank line that is already there', () => {
    expect(exit(`Before.\n\n${TABLE}`, 'above')).toBe(`Before.\n|\n${TABLE}`);
  });
});
