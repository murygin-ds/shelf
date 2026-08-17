import { syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { noteLanguage } from './language';
import { wikilinkParts } from './wikilink';

/**
 * The parser exists to beat one specific reading: without it the markdown grammar takes the
 * inner pair of brackets in `[[Title]]` for a shortcut reference link, and live preview then
 * hides a bracket from each side as link markup. These pin that it wins, and that it gives
 * up on the same inputs `parseWikilinks` gives up on.
 */

function links(doc: string): string[] {
  const state = EditorState.create({ doc, extensions: [noteLanguage] });
  const found: string[] = [];

  syntaxTree(state).iterate({
    enter: (node) => {
      if (node.name === 'Wikilink') found.push(doc.slice(node.from, node.to));
    },
  });

  return found;
}

/** Node names the grammar produced, so a claim about what it did *not* build is checkable. */
function names(doc: string): Set<string> {
  const state = EditorState.create({ doc, extensions: [noteLanguage] });
  const found = new Set<string>();

  syntaxTree(state).iterate({ enter: (node) => void found.add(node.name) });

  return found;
}

describe('the wikilink parser', () => {
  it('claims the whole construct', () => {
    expect(links('see [[Roadmap]] now')).toEqual(['[[Roadmap]]']);
    expect(links('[[Launch Plan|the plan]]')).toEqual(['[[Launch Plan|the plan]]']);
    expect(links('[[a]] and [[b]]')).toEqual(['[[a]]', '[[b]]']);
  });

  // The whole reason this parser exists: no Link node means no LinkMark, and no LinkMark
  // means live preview never eats the brackets.
  it('leaves no reference link behind for the brackets to come from', () => {
    expect(names('[[Файл 2]]')).not.toContain('Link');
  });

  it('still parses ordinary links', () => {
    expect(names('[text](http://x.test)')).toContain('Link');
    expect(links('[text](http://x.test)')).toEqual([]);
  });

  it('gives up where parseWikilinks gives up', () => {
    expect(links('[[]]')).toEqual([]);
    expect(links('[[ ]]')).toEqual([]);
    expect(links('[[unclosed')).toEqual([]);
    expect(links('[[start\nend]]')).toEqual([]);
    expect(links('[single]')).toEqual([]);
  });
});

describe('splitting a wikilink', () => {
  it('reads a plain target', () => {
    const parts = wikilinkParts('[[Roadmap]]');

    expect(parts.target).toBe('Roadmap');
    expect(parts.label).toBe('Roadmap');
  });

  it('prefers the alias as the label', () => {
    expect(wikilinkParts('[[Launch Plan|the plan]]').label).toBe('the plan');
  });

  it('falls back to the target when the alias is empty', () => {
    // `[[A|]]` has a bar but nothing after it. Treating that as an alias would render the
    // link as an empty string — a link the reader cannot see, let alone click.
    expect(wikilinkParts('[[A|]]').label).toBe('A');
    expect(wikilinkParts('[[A| ]]').label).toBe('A');
  });

  it.each([
    ['[[Roadmap]]', 'Roadmap'],
    ['[[Launch Plan|the plan]]', 'the plan'],
    ['[[A|]]', 'A'],
    ['[[A| ]]', 'A'],
  ])('%s reads as %j once the hidden parts are cut', (text, expected) => {
    const { hidden } = wikilinkParts(text);

    let out = '';
    let at = 0;

    for (const [from, to] of [...hidden].sort((a, b) => a[0] - b[0])) {
      if (from > at) out += text.slice(at, from);
      at = Math.max(at, to);
    }

    expect(out + text.slice(at)).toBe(expected);
  });
});
