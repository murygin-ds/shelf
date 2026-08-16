import { describe, expect, it } from 'vitest';

import { parseWikilinks, resolveWikilinks } from './wikilinks';

const NOTES = [
  { id: 1, name: 'Roadmap' },
  { id: 2, name: 'launch plan' },
  { id: 3, name: 'Roadmap' },
];

describe('parseWikilinks', () => {
  it('reads targets and aliases', () => {
    const found = parseWikilinks('see [[Roadmap]] and [[Launch Plan|the plan]]');

    expect(found.map((link) => [link.target, link.label])).toEqual([
      ['Roadmap', 'Roadmap'],
      ['Launch Plan', 'the plan'],
    ]);
  });

  it('ignores brackets that are not links', () => {
    expect(parseWikilinks('[[]] [[ ]] [single] [[unclosed')).toEqual([]);
  });

  it('does not run across a line', () => {
    // Without this a stray bracket would swallow the rest of the note into one "title".
    expect(parseWikilinks('[[start\nend]]')).toEqual([]);
  });
});

describe('resolveWikilinks', () => {
  it('matches titles regardless of case and surrounding space', () => {
    const { resolved } = resolveWikilinks('[[  launch PLAN ]]', NOTES);

    expect(resolved).toEqual([2]);
  });

  it('keeps a title that matches nothing on this device', () => {
    // Sending it would publish the text of a link the writer could not resolve, which is
    // the one thing the server must never learn from the graph.
    const { resolved, unresolved } = resolveWikilinks('[[Roadmap]] [[Nowhere]]', NOTES);

    expect(resolved).toEqual([1]);
    expect(unresolved).toEqual(['Nowhere']);
  });

  it('settles a duplicate title on the older note', () => {
    // Two notes may legitimately share a name; picking deterministically at least means
    // the same body resolves the same way twice.
    expect(resolveWikilinks('[[Roadmap]]', NOTES).resolved).toEqual([1]);
  });

  it('drops a link to itself and repeats of the same target', () => {
    const { resolved } = resolveWikilinks('[[Roadmap]] [[Roadmap]] [[launch plan]]', NOTES, 1);

    expect(resolved).toEqual([2]);
  });
});
