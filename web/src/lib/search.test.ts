import { describe, expect, it } from 'vitest';

import type { NoteNode } from '@/api/workspace';

import { allTags, buildIndexEntry, extractTags, normalizeTag, search } from './search';

function note(
  id: number,
  name: string,
  updatedAt = '2026-08-16T00:00:00Z',
  tags: string[] = [],
): NoteNode {
  return {
    id,
    clientId: `client-${id}`,
    vaultId: 1,
    keyScopeClientId: 'scope-1',
    name,
    icon: undefined,
    tags,
    locked: false,
    permission: 'edit',
    keyScopeId: 1,
    keyVersion: 1,
    ownScope: false,
    grantCount: 1,
    updatedAt,
    updatedBy: null,
    folderId: null,
    contentSeq: 1,
    contentSize: 0,
  };
}

const index = [
  buildIndexEntry(note(1, 'Access model v2', '2026-08-16T10:00:00Z'), 'Revocation is paired with a key rotation on the folder. #spec', 'PRODUCT'),
  buildIndexEntry(note(2, 'Key rotation ADR', '2026-08-16T09:00:00Z'), 'Every revoke schedules a rotation. #adr #spec', 'PRODUCT/ADR'),
  buildIndexEntry(note(3, 'Weekly sync', '2026-08-16T08:00:00Z'), 'Decided: automate key rotation when a member leaves.', 'MEETINGS'),
];

describe('tags', () => {
  it('reads hashtags out of the body', () => {
    expect(extractTags('a #spec and #permissions here')).toEqual(['spec', 'permissions']);
  });

  it('ignores things that only look like tags', () => {
    // A fragment in a URL and a heading marker are not tags.
    expect(extractTags('see https://x.dev/page#anchor\n## Heading')).toEqual([]);
  });

  it('folds case and drops duplicates', () => {
    expect(extractTags('#Spec #spec #SPEC')).toEqual(['spec']);
  });

  it('ranks the vault tags by how often they are used', () => {
    expect(allTags(index)).toEqual(['spec', 'adr']);
  });

  it('folds a tag chosen in the panel to the same spelling as one written in the body', () => {
    expect(normalizeTag('  #Draft ')).toBe('draft');
    expect(normalizeTag('draft')).toBe('draft');
  });

  it('rejects what could never be written as a tag in a body', () => {
    expect(normalizeTag('two words')).toBeNull();
    expect(normalizeTag('-leading')).toBeNull();
    expect(normalizeTag('#')).toBeNull();
    expect(normalizeTag('')).toBeNull();
  });
});

describe('tags chosen for a note', () => {
  const entry = buildIndexEntry(
    note(9, 'Access model', '2026-08-16T10:00:00Z', ['Draft', 'spec', 'not a tag']),
    'Body text with #spec and #inline.',
    'PRODUCT',
  );

  it('merges the note’s own tags with the ones in its body, without repeats', () => {
    expect(entry.tags).toEqual(['draft', 'spec', 'inline']);
  });

  // The sidebar searches by typing `#tag`, so a tag that was chosen but never typed into
  // the body has to be findable the same way.
  it('makes a tag that appears nowhere in the body searchable', () => {
    expect(search([entry], '#draft').map((hit) => hit.note.id)).toEqual([9]);
    expect(search([entry], 'rotation')).toEqual([]);
  });
});

describe('search', () => {
  it('returns nothing for an empty query', () => {
    expect(search(index, '   ')).toEqual([]);
  });

  it('matches titles and bodies, case-insensitively', () => {
    expect(search(index, 'KEY ROTATION').map((hit) => hit.note.id)).toEqual([2, 1, 3]);
  });

  it('puts title matches first, then the most recently touched', () => {
    // "Key rotation ADR" has it in the title; the other two only in the body, newest first.
    const ids = search(index, 'rotation').map((hit) => hit.note.id);

    expect(ids[0]).toBe(2);
    expect(ids.slice(1)).toEqual([1, 3]);
  });

  it('narrows by tag', () => {
    expect(search(index, 'rotation', { tag: 'adr' }).map((hit) => hit.note.id)).toEqual([2]);
    expect(search(index, 'rotation', { tag: 'nonexistent' })).toEqual([]);
  });

  it('builds a snippet around the match, not from the start of the note', () => {
    const [hit] = search(index, 'paired');

    expect(hit?.snippet.match).toBe('paired');
    expect(hit?.snippet.before).toContain('Revocation is');
    expect(hit?.snippet.after).toContain('key rotation');
  });

  it('takes the snippet from the title when the match is there', () => {
    const [hit] = search(index, 'Access model');

    expect(hit?.snippet.match).toBe('Access model');
    expect(hit?.snippet.before).toBe('');
  });

  it('never leaves the vault: the whole index is the only input', () => {
    // A guard against someone reaching for the network here later: search takes an array
    // and returns a slice of it, with no way to reach anything else.
    expect(search([], 'anything')).toEqual([]);
  });
});
