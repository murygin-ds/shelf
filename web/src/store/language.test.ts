import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { language } from '@/i18n';

import { switchLanguage } from './language';

/**
 * What has to happen before the page goes away.
 *
 * The reload is the whole mechanism — the dictionary is bound at import — so the only thing
 * worth asserting is the order around it: the choice written first, the open note flushed,
 * and the reload last.
 */

const saveNote = vi.fn(() => pending);
const reload = vi.fn();

let pending: Promise<void>;
let settle: () => void;

vi.mock('./session', () => ({ useSession: { getState: () => ({ identity: null }) } }));
vi.mock('./workspace', () => ({ useWorkspace: { getState: () => ({ saveNote }) } }));

beforeEach(() => {
  pending = new Promise<void>((resolve) => (settle = resolve));
  saveNote.mockClear();
  reload.mockClear();

  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  });
  vi.stubGlobal('window', { location: { reload } });
});

afterEach(() => vi.unstubAllGlobals());

describe('switchLanguage', () => {
  it('writes the choice before waiting on the save', async () => {
    switchLanguage('en');

    expect(language()).toBe('en');
    expect(saveNote).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();

    settle();
    await pending;
    await Promise.resolve();

    expect(reload).toHaveBeenCalledOnce();
  });

  it('does nothing when the language is already the one asked for', () => {
    switchLanguage('ru');

    expect(saveNote).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });
});
