import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT, LANGUAGES, language, NAME, setLanguage } from './locale';

/**
 * The choice, and the two ways storage can refuse to keep it.
 *
 * `language()` reads on every call rather than caching: a chooser has to draw the answer
 * that was just written, and the dictionary it binds is a separate question — one settled
 * by the reload, not by this module.
 */

function memory(): Storage {
  const map = new Map<string, string>();

  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
    clear: () => map.clear(),
    key: (index) => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

/** Private mode: reading works, writing throws. */
function sealed(): Storage {
  return {
    ...memory(),
    setItem: () => {
      throw new DOMException('write denied');
    },
  } as Storage;
}

beforeEach(() => vi.stubGlobal('localStorage', memory()));
afterEach(() => vi.unstubAllGlobals());

describe('language', () => {
  it('is the default until somebody chooses otherwise', () => {
    expect(language()).toBe(DEFAULT);
  });

  it('remembers a choice and keeps the default unwritten', () => {
    setLanguage('en');
    expect(language()).toBe('en');
    expect(localStorage.length).toBe(1);

    setLanguage('ru');
    expect(language()).toBe('ru');
    expect(localStorage.length).toBe(0);
  });

  it('falls back to the default when storage cannot be written', () => {
    vi.stubGlobal('localStorage', sealed());

    expect(() => setLanguage('en')).not.toThrow();
    expect(language()).toBe(DEFAULT);
  });

  it('has a name for every language it offers', () => {
    for (const code of LANGUAGES) expect(NAME[code].trim()).not.toBe('');
  });
});
