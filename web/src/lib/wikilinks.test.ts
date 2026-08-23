import { describe, expect, it } from 'vitest';

import {
  linkTargets,
  parseWikilinks,
  resolvables,
  resolveTarget,
  resolveWikilinks,
} from './wikilinks';

const NOTES = [
  { id: 1, name: 'Roadmap' },
  { id: 2, name: 'launch plan' },
  { id: 3, name: 'Roadmap' },
];

// The shape the connector's tree has: one CLAUDE.md per project, which is exactly the case
// a title cannot settle.
const VAULT = [
  { id: 1, name: 'CLAUDE.md', path: 'CLAUDE.md' },
  { id: 2, name: 'profile.md', path: 'context/profile.md' },
  { id: 3, name: 'CLAUDE.md', path: 'projects/shelf/CLAUDE.md' },
  { id: 4, name: 'CLAUDE.md', path: 'projects/atlas/CLAUDE.md' },
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

describe('paths as link targets', () => {
  it('tells repeated titles apart by path', () => {
    const body = '[[projects/atlas/CLAUDE.md]] [[/projects/shelf/CLAUDE.md/]]';

    expect(resolveWikilinks(body, VAULT).resolved).toEqual([4, 3]);
  });

  it('still settles a bare title on the older note', () => {
    // The tie-break has to stay what it was: a person typing [[CLAUDE.md]] in the editor
    // gets the same note the connector would resolve from the same text.
    expect(resolveWikilinks('[[CLAUDE.md]]', VAULT).resolved).toEqual([1]);
  });

  it('prefers a path over a title that spells the same string', () => {
    const notes = [
      { id: 1, name: 'context/profile.md', path: 'decoy.md' },
      { id: 2, name: 'profile.md', path: 'context/profile.md' },
    ];

    expect(resolveTarget('context/profile.md', linkTargets(notes))).toBe(2);
  });

  it('keeps an unmatched path on this device', () => {
    const { resolved, unresolved } = resolveWikilinks('[[projects/gone/CLAUDE.md]]', VAULT);

    expect(resolved).toEqual([]);
    expect(unresolved).toEqual(['projects/gone/CLAUDE.md']);
  });
});

describe('resolvables', () => {
  const FOLDERS = [
    { id: 10, parentId: null, name: 'projects' },
    { id: 11, parentId: 10, name: 'shelf' },
  ];

  it('names each note by the folders above it', () => {
    const notes = [
      { id: 1, name: 'CLAUDE.md', folderId: null },
      { id: 2, name: 'CLAUDE.md', folderId: 11 },
    ];

    expect(resolvables(FOLDERS, notes).map((note) => note.path)).toEqual([
      'CLAUDE.md',
      'projects/shelf/CLAUDE.md',
    ]);
  });

  it('starts the path at the deepest folder that arrived', () => {
    // A parent this reader cannot see is not an error: the notes under it are still notes,
    // and a path missing its top is better than no path at all.
    const orphan = [{ id: 11, parentId: 99, name: 'shelf' }];

    expect(resolvables(orphan, [{ id: 1, name: 'notes.md', folderId: 11 }])[0]?.path).toBe(
      'shelf/notes.md',
    );
  });
});
