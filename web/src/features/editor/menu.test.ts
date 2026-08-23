import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MenuEntry } from '@/ui/ContextMenu';

import { noteLanguage } from './language';
import { editorMenu } from './menu';

/**
 * The body menu is the one place the writing verbs are reachable without a keystroke.
 *
 * The formatting entries build a transaction spec and answer null while the state is
 * read-only, so they are inert wherever they appear — but Cut and Paste dispatch changes of
 * their own, and nothing downstream would stop them.
 */

function view(doc: string, options: { readOnly?: boolean; select?: [number, number] } = {}) {
  const state = EditorState.create({
    doc,
    ...(options.select ? { selection: { anchor: options.select[0], head: options.select[1] } } : {}),
    extensions: [noteLanguage, EditorState.readOnly.of(options.readOnly ?? false)],
  });

  return { state } as unknown as EditorView;
}

/**
 * What each entry is, not what it says. A panel has no identity of its own — it is the grid
 * inside the table submenu — and the words are the dictionary's business, so a reworded
 * label must not turn into a failing test here.
 */
function ids(entries: MenuEntry[]): string[] {
  return entries.flatMap((entry) => (entry.kind === 'panel' || !entry.id ? [] : [entry.id]));
}

const menu = (subject: EditorView) => ids(editorMenu(subject, 0, () => undefined));

beforeEach(() => {
  // Node has a navigator without a clipboard, and the menu leaves those entries out when
  // there is none — which would make every assertion here pass for the wrong reason.
  vi.stubGlobal('navigator', {
    clipboard: { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the body menu while writing', () => {
  it('offers the clipboard both ways over a selection', () => {
    expect(menu(view('ship on tuesday', { select: [0, 4] }))).toEqual(
      expect.arrayContaining(['cut', 'copy', 'paste']),
    );
  });

  it('offers what can be written where nothing is selected', () => {
    expect(menu(view('ship on tuesday'))).toEqual(
      expect.arrayContaining(['table', 'heading', 'divider', 'paste']),
    );
  });
});

describe('the body menu while reading', () => {
  it('takes out everything that writes, including the clipboard verbs that dispatch', () => {
    const entries = menu(view('ship on tuesday', { readOnly: true, select: [0, 4] }));

    expect(entries).toContain('copy');
    expect(entries).not.toContain('cut');
    expect(entries).not.toContain('paste');
    expect(entries).not.toContain('bold');
  });

  it('offers nothing at all with no selection, so the platform menu can stand', () => {
    expect(menu(view('ship on tuesday', { readOnly: true }))).toEqual([]);
  });

  it('still opens a link, which is the one verb that reads', () => {
    const doc = 'see [[Roadmap]] for the rest';
    const at = doc.indexOf('Roadmap');

    const entries = ids(editorMenu(view(doc, { readOnly: true }), at, () => undefined));

    expect(entries).toEqual(['open', 'open-tab']);
  });
});
