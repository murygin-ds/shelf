import { describe, expect, it } from 'vitest';

import { type Place, pathOf, placeOf, samePath } from './place';

const places: Place[] = [
  { vaultId: null, view: 'editor', noteId: null, query: '' },
  { vaultId: 3, view: 'editor', noteId: null, query: '' },
  { vaultId: 3, view: 'editor', noteId: 17, query: '' },
  { vaultId: 3, view: 'claude', noteId: null, query: '' },
  { vaultId: 3, view: 'graph', noteId: null, query: '' },
  { vaultId: 3, view: 'trash', noteId: null, query: '' },
  { vaultId: 3, view: 'profile', noteId: null, query: '' },
  { vaultId: 3, view: 'search', noteId: null, query: 'key rotation' },
  { vaultId: 3, view: 'search', noteId: null, query: '' },
];

describe('place', () => {
  it('survives a round trip through the URL', () => {
    for (const place of places) {
      const [pathname = '/', search] = pathOf(place).split('?');

      expect(placeOf(pathname, search ? `?${search}` : '')).toEqual(place);
    }
  });

  it('builds the paths the shell links to', () => {
    expect(pathOf({ vaultId: null, view: 'editor', noteId: null, query: '' })).toBe('/');
    expect(pathOf({ vaultId: 3, view: 'editor', noteId: 17, query: '' })).toBe('/v/3/n/17');
    expect(pathOf({ vaultId: 3, view: 'search', noteId: null, query: 'a b' })).toBe(
      '/v/3/search?q=a%20b',
    );
  });

  it('leaves the note out of the views that do not show one', () => {
    expect(pathOf({ vaultId: 3, view: 'graph', noteId: 17, query: '' })).toBe('/v/3/graph');
    expect(pathOf({ vaultId: 3, view: 'claude', noteId: 17, query: '' })).toBe('/v/3/claude');
    expect(placeOf('/v/3/graph', '')).toEqual({
      vaultId: 3,
      view: 'graph',
      noteId: null,
      query: '',
    });
  });

  it('reads a note path with no vault in it', () => {
    expect(placeOf('/n/17', '')).toEqual({ vaultId: null, view: 'editor', noteId: 17, query: '' });
  });

  it('falls back to the editor on anything it does not know', () => {
    expect(placeOf('/nonsense/here', '')).toEqual({
      vaultId: null,
      view: 'editor',
      noteId: null,
      query: '',
    });
  });

  it('refuses ids that are not ids', () => {
    expect(placeOf('/v/abc/n/1.5', '')).toEqual({
      vaultId: null,
      view: 'editor',
      noteId: null,
      query: '',
    });
    expect(placeOf('/v/3/n/0', '')).toEqual({
      vaultId: 3,
      view: 'editor',
      noteId: null,
      query: '',
    });
  });

  it('tells a query-only change from a move', () => {
    expect(samePath('/v/3/search?q=a', '/v/3/search?q=b')).toBe(true);
    expect(samePath('/v/3/search?q=a', '/v/3/n/17')).toBe(false);
  });
});
