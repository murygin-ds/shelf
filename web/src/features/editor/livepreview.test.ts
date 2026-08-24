import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { contextOf, vaultContext } from './context';
import { noteLanguage } from './language';
import { buildDecorations, toggleTask, type Span } from './livepreview';

/**
 * Live preview decides what a note looks like when nobody is typing in it, so a mistake here
 * shows the reader something other than what they wrote. These pin the rules that are not
 * obvious from the code: what gets hidden, what must never be hidden, and where the caret
 * changes the answer.
 */

// A note is named by the last segment of what is passed, and reachable by the whole of it:
// links are written as either, and the editor has to draw both as resolved.
function open(doc: string, titles: string[] = [], readOnly = false): EditorState {
  const notes = titles.map((path, id) => ({ id, name: path.split('/').pop() ?? path, path }));

  return EditorState.create({
    doc,
    extensions: [
      noteLanguage,
      vaultContext.of(contextOf(notes, [])),
      EditorState.readOnly.of(readOnly),
    ],
  });
}

/** The document as a reader sees it, with every concealed range removed. */
function rendered(doc: string, caret?: number, titles: string[] = []): string {
  const state = open(doc, titles);
  const spans: Span[] = caret === undefined ? [] : [{ from: caret, to: caret }];
  const { hidden } = buildDecorations(state, [{ from: 0, to: doc.length }], spans);

  const cuts: Span[] = [];
  hidden.between(0, doc.length, (from, to) => {
    cuts.push({ from, to });
  });

  let out = '';
  let at = 0;

  for (const cut of cuts.sort((a, b) => a.from - b.from)) {
    if (cut.from > at) out += doc.slice(at, cut.from);
    at = Math.max(at, cut.to);
  }

  return out + doc.slice(at);
}

/** The classes live preview put on spans of text, as opposed to on whole lines. */
function marks(doc: string, titles: string[] = []): string[] {
  const state = open(doc, titles);
  const { decorations } = buildDecorations(state, [{ from: 0, to: doc.length }], []);

  const out: string[] = [];

  decorations.between(0, doc.length, (from, to, value) => {
    const cls = (value.spec as { class?: string }).class;

    if (from !== to && cls) out.push(cls);
  });

  return out;
}

interface Box {
  done: boolean;
  readOnly: boolean;
}

/**
 * The checkboxes, as the range each one covers and the state it was built from. There is no
 * DOM here — these tests run without one — but the widget is what decides what the DOM will
 * say, so reading it is reading the checkbox.
 */
function boxes(doc: string, caret?: number, readOnly = false): Array<Span & Box> {
  const state = open(doc, [], readOnly);
  const spans: Span[] = caret === undefined ? [] : [{ from: caret, to: caret }];
  const { decorations } = buildDecorations(state, [{ from: 0, to: doc.length }], spans);

  const out: Array<Span & Box> = [];

  decorations.between(0, doc.length, (from, to, value) => {
    const widget = (value.spec as { widget?: Box }).widget;

    if (widget) out.push({ from, to, done: widget.done, readOnly: widget.readOnly });
  });

  return out;
}

/** Line number -> the classes live preview put on it. */
function classes(doc: string, visible: Span[]): Map<number, string[]> {
  const state = open(doc);
  const { decorations } = buildDecorations(state, visible, []);

  const out = new Map<number, string[]>();

  decorations.between(0, doc.length, (from, to, value) => {
    // Line decorations are the empty ranges anchored at a line start.
    if (from !== to) return;

    const at = state.doc.lineAt(from).number;
    const cls = (value.spec as { class?: string }).class;

    if (cls) out.set(at, [...(out.get(at) ?? []), cls]);
  });

  return out;
}

describe('what the reader sees', () => {
  it('hides the marker of a heading the caret is not on', () => {
    expect(rendered('# Test')).toBe('Test');
  });

  it('shows it again once the caret is on that line', () => {
    expect(rendered('# Test', 3)).toBe('# Test');
  });

  it('leaves other lines rendered while one line is being edited', () => {
    expect(rendered('# Test\n\n> quoted', 3)).toBe('# Test\n\nquoted');
  });

  it('hides emphasis, code and link markup', () => {
    expect(rendered('a **b** c *d* e `f` g [h](http://i.test)')).toBe('a b c d e f g h');
  });

  it('keeps a bullet, which is what creates the indent', () => {
    expect(rendered('- one\n- two')).toBe('- one\n- two');
  });
});

describe('wikilinks', () => {
  // The bug this whole construct exists for: read as a reference link, `[[Файл 2]]` lost one
  // bracket from each side and rendered as `[Файл 2]`.
  it('shows the title without any brackets at all', () => {
    expect(rendered('см. [[Файл 2]] ок')).toBe('см. Файл 2 ок');
  });

  it('shows the alias rather than the target', () => {
    expect(rendered('[[Launch Plan|the plan]]')).toBe('the plan');
  });

  it('keeps the target when the bar has nothing after it', () => {
    expect(rendered('[[A|]]')).toBe('A');
  });

  it('gives the brackets back once the caret is on that line', () => {
    expect(rendered('[[Roadmap]]', 4)).toBe('[[Roadmap]]');
  });

  it('marks a link to a note that exists differently from one that does not', () => {
    expect(marks('[[Roadmap]]', ['Roadmap'])).toContain('cm-md-wiki');
    expect(marks('[[Roadmap]]', ['Roadmap'])).not.toContain('cm-md-wiki cm-md-wiki-missing');
    expect(marks('[[Nowhere]]', ['Roadmap'])).toContain('cm-md-wiki cm-md-wiki-missing');
  });

  it('matches titles the way the graph does, ignoring case and surrounding space', () => {
    expect(marks('[[  launch PLAN ]]', ['Launch Plan'])).toContain('cm-md-wiki');
  });

  // Claude writes links by path, because the tree it fills repeats titles. They are drawn
  // as resolved for the same reason they resolve: they name a note this reader can open.
  it('draws a link written as a path as resolved', () => {
    const vault = ['projects/shelf/CLAUDE.md'];

    expect(marks('[[projects/shelf/CLAUDE.md]]', vault)).toContain('cm-md-wiki');
    expect(marks('[[CLAUDE.md]]', vault)).toContain('cm-md-wiki');
    expect(marks('[[projects/atlas/CLAUDE.md]]', vault)).toContain('cm-md-wiki cm-md-wiki-missing');
  });
});

describe('text that must never be concealed', () => {
  // An autolink has no separate link text: the URL is the only thing on the line, so hiding
  // it alongside the angle brackets renders a note holding one bookmark as blank.
  it('keeps the address of an autolink', () => {
    expect(rendered('see <https://example.com> ok')).toBe('see https://example.com ok');
    expect(rendered('<me@example.com>')).toBe('me@example.com');
  });

  it('keeps a bare autolink', () => {
    expect(rendered('bare https://example.com ok')).toBe('bare https://example.com ok');
  });

  it('keeps a link reference definition, which is markup all the way through', () => {
    expect(rendered('[ref]: https://example.com')).toBe('[ref]: https://example.com');
  });

});

describe('checkboxes', () => {
  const doc = '- [x] Сделано\n- [ ] Не сделано';

  it('hides the bullet and the box together, leaving the text of the task', () => {
    expect(rendered(doc)).toBe('Сделано\nНе сделано');
  });

  it('draws one checkbox per item, ticked as the marker says', () => {
    expect(boxes(doc)).toEqual([
      { from: 0, to: 6, done: true, readOnly: false },
      { from: 14, to: 20, done: false, readOnly: false },
    ]);
  });

  // The same rule as every other marker here: the line the caret is on is the line being
  // written, and what is written there is `- [x]`.
  it('gives the markdown back on the line the caret is on, and only there', () => {
    expect(rendered(doc, 8)).toBe('- [x] Сделано\nНе сделано');
    expect(boxes(doc, 8).map((box) => box.from)).toEqual([14]);
  });

  it('takes an upper-case X as ticked', () => {
    expect(boxes('- [X] done').map((box) => box.done)).toEqual([true]);
  });

  it('draws one on an ordered item and on a nested one', () => {
    expect(boxes('1. [ ] first')).toEqual([{ from: 0, to: 7, done: false, readOnly: false }]);
    expect(boxes('- a\n  - [ ] deep')).toEqual([{ from: 6, to: 12, done: false, readOnly: false }]);
  });

  // `- [ ]` alone is not a task to the parser — there is nothing for the box to belong to —
  // and a bullet that lost its dash to a checkbox nobody can see is a list with a hole in it.
  it('leaves a marker with nothing after it as text', () => {
    expect(boxes('- [ ]')).toEqual([]);
    expect(rendered('- [ ]')).toBe('- [ ]');
  });

  it('leaves an ordinary bullet alone', () => {
    expect(boxes('- one')).toEqual([]);
    expect(rendered('- one')).toBe('- one');
  });

  it('draws the box unavailable on a note that may not be written', () => {
    expect(boxes(doc, undefined, true).map((box) => box.readOnly)).toEqual([true, true]);
  });
});

describe('ticking a box', () => {
  const doc = '- [ ] one\n- [x] two';

  // One character, so the rest of the line — and anyone else editing it — is untouched.
  it('writes the one character between the brackets', () => {
    expect(toggleTask(open(doc), 0)).toEqual({ changes: { from: 3, to: 4, insert: 'x' } });
    expect(toggleTask(open(doc), 10)).toEqual({ changes: { from: 13, to: 14, insert: ' ' } });
  });

  it('answers for the task the position is on, wherever on the line it is', () => {
    expect(toggleTask(open(doc), 7)).toEqual({ changes: { from: 3, to: 4, insert: 'x' } });
  });

  it('has nothing to say about a line that is not a task', () => {
    expect(toggleTask(open('- one'), 2)).toBeNull();
    expect(toggleTask(open('# heading'), 2)).toBeNull();
  });

  // The widget on screen was drawn under whatever mode held at the time, so read-only is
  // answered here rather than trusted to have reached the checkbox first.
  it('refuses on a note that may not be written', () => {
    expect(toggleTask(open(doc, [], true), 0)).toBeNull();
  });
});

describe('fenced code', () => {
  const doc = '```js\nconst x = 1;\n```';

  it('drops the fence and the language once nobody is in the block', () => {
    expect(rendered(doc)).toBe('\nconst x = 1;\n');
  });

  // While a block is being written the closing fence is the only thing saying where it
  // ends, so it comes back for the whole block rather than for the caret's line alone.
  it('brings the whole fence back while the caret is inside', () => {
    expect(rendered(doc, 10)).toBe(doc);
    expect(rendered(doc, 0)).toBe(doc);
  });

  it('leaves it hidden when the caret is on a line outside the block', () => {
    const withProse = `${doc}\n\nafter`;

    expect(rendered(withProse, withProse.length)).toBe('\nconst x = 1;\n\n\nafter');
  });
});

describe('block edges across a split viewport', () => {
  const doc = '```js\na\nb\nc\n```';

  it('rounds the first and last line of a fenced block', () => {
    const map = classes(doc, [{ from: 0, to: doc.length }]);

    expect(map.get(1)).toContain('cm-md-codefirst');
    expect(map.get(5)).toContain('cm-md-codelast');
    expect(map.get(3)).toEqual(['cm-md-codeline']);
  });

  // A viewport boundary can land inside a block. The corners belong to the block, not to
  // the slice that happens to be on screen.
  it('does not round a boundary that falls inside the block', () => {
    const map = classes(doc, [
      { from: 0, to: 8 },
      { from: 9, to: doc.length },
    ]);

    expect(map.get(2)).not.toContain('cm-md-codelast');
    expect(map.get(3)).not.toContain('cm-md-codefirst');
    expect(map.get(1)).toContain('cm-md-codefirst');
    expect(map.get(5)).toContain('cm-md-codelast');
  });
});

describe('malformed input', () => {
  // Every one of these has produced an illegal decoration range at some point: an empty
  // replace or a line decoration that is not empty throws when the view draws it.
  const nasty = [
    '#',
    '#no-space',
    '# ',
    '***',
    '```js\nunclosed',
    '> - list in quote',
    '[link](\nbroken)',
    'a**b**c**d',
    '~~s~~',
    '- [ ] task',
    '- [x]',
    '- [ ] ',
    '> - [x] quoted',
    '- [x] **bold** and [[link]]',
    '',
    'x'.repeat(2000),
    '## \n\n### x ###',
    '![img](a.png)',
    'Setext\n======',
    '[[]]',
    '[[',
    '[[a',
    '[[a|b',
    '[[[a]]]',
    '[[a]] [[b]]',
    '[[a|]]',
    '| a | b |\n| - | - |\n| 1 | 2 |',
  ];

  it.each(nasty)('builds a legal decoration set for %j', (doc) => {
    expect(() => buildDecorations(open(doc), [{ from: 0, to: doc.length }], [])).not.toThrow();
    expect(() => buildDecorations(open(doc), [{ from: 0, to: doc.length }], [{ from: 0, to: 1 }])).not.toThrow();
  });
});
