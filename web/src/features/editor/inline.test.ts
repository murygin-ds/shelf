import { describe, expect, it } from 'vitest';

import { inlineSpans, isPlain, sourceOffset, type InlineSpan } from './inline';

/**
 * What a table cell shows. Everywhere else in a note the markdown stays on screen and is
 * merely styled; here it is replaced, so a mistake does not look like a mistake — it looks
 * like text the reader never wrote.
 */

/** The cell as it reads, with the markup taken out. */
function shown(source: string): string {
  return inlineSpans(source)
    .map((span) => span.text)
    .join('');
}

/** Each span as `text` plus what it is, for the cases where the styling is the point. */
function styled(source: string): string[] {
  return inlineSpans(source).map((span) => {
    const marks = ['code', 'strong', 'em', 'strike', 'link'].filter(
      (mark) => span[mark as keyof InlineSpan],
    );

    if (span.wiki !== undefined) marks.push(`wiki:${span.wiki}`);

    return marks.length ? `${span.text}<${marks.join(',')}>` : span.text;
  });
}

describe('what a cell shows', () => {
  it('leaves text that carries no markup alone', () => {
    expect(styled('just words')).toEqual(['just words']);
  });

  it('drops the markers around emphasis and code', () => {
    expect(styled('`x` and **b** and *i* and ~~s~~')).toEqual([
      'x<code>',
      ' and ',
      'b<strong>',
      ' and ',
      'i<em>',
      ' and ',
      's<strike>',
    ]);
  });

  it('carries both faces of nested emphasis', () => {
    expect(styled('***both***')).toEqual(['both<strong,em>']);
  });

  it('keeps a style across the pieces of what it wraps', () => {
    expect(styled('**bold `code`**')).toEqual(['bold <strong>', 'code<code,strong>']);
  });

  it('shows a link by its label and never its url', () => {
    expect(styled('[label](https://example.com)')).toEqual(['label<link>']);
  });

  // The url is the only text there is; hiding it with the brackets blanks the cell.
  it('shows an autolink, which is its own label', () => {
    expect(styled('<https://example.com>')).toEqual(['https://example.com<link>']);
    expect(styled('https://example.com')).toEqual(['https://example.com<link>']);
  });

  it('shows an image by its alt text', () => {
    expect(styled('![alt](pic.png)')).toEqual(['alt<link>']);
  });

  it('shows a wikilink by its title', () => {
    expect(styled('[[Note]]')).toEqual(['Note<wiki:Note>']);
  });

  it('shows an aliased wikilink by its alias, and still knows the target', () => {
    expect(styled('[[folder/Note|shown]]')).toEqual(['shown<wiki:folder/Note>']);
  });

  // A cell is inline content: at the front of one those characters are what they look like.
  it('leaves a hash and a bullet at the start of a cell as text', () => {
    expect(styled('# not a heading')).toEqual(['# not a heading']);
    expect(styled('- not a bullet')).toEqual(['- not a bullet']);
  });

  // The cells are built as text nodes, so a tag written in one is text like any other. This
  // pins that it is never read as markup on the way there either.
  it('leaves an html tag as text', () => {
    expect(shown('<b>x</b>')).toBe('<b>x</b>');
  });

  it('has nothing to show for an empty cell', () => {
    expect(inlineSpans('')).toEqual([]);
  });
});

describe('where what is shown came from', () => {
  // The invariant the caret rides on: a span is a slice of the source, never a rewrite of it.
  it('slices the source rather than rebuilding it', () => {
    for (const source of ['`x` **b** [[a|b]] [l](u) plain', '~~s~~ text', '***x*** y']) {
      for (const span of inlineSpans(source)) {
        expect(source.slice(span.from, span.to)).toBe(span.text);
      }
    }
  });

  it('puts the caret on the character it was clicked on', () => {
    const source = '**bold** tail';
    const spans = inlineSpans(source);

    // Shown as `bold tail`: offset 2 is the `l`, offset 4 the space that follows the word.
    expect(sourceOffset(spans, 2)).toBe(source.indexOf('l'));
    expect(sourceOffset(spans, 4)).toBe(source.indexOf(' tail'));
    expect(sourceOffset(spans, 0)).toBe(2);
  });

  it('answers the end of the text for a click past it', () => {
    expect(sourceOffset(inlineSpans('`x`'), 9)).toBe(2);
    expect(sourceOffset([], 3)).toBe(3);
  });
});

describe('telling a plain cell from a marked-up one', () => {
  it('is plain when nothing is styled', () => {
    expect(inlineSpans('words').every(isPlain)).toBe(true);
  });

  it('is not plain for a link with nothing else in it', () => {
    expect(inlineSpans('[[Note]]').every(isPlain)).toBe(false);
  });
});
