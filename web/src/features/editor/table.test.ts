import { describe, expect, it } from 'vitest';

import { alignsOf, serialize, type TableModel } from './table';

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
