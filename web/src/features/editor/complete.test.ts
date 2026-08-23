import { CompletionContext } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import { tagSource, wikilinkSource } from './complete';
import { contextOf, vaultContext } from './context';
import { noteLanguage } from './language';

/**
 * The sources decide what a reader is offered mid-sentence, so the interesting cases are the
 * ones where nothing should appear: a heading marker is not a tag, and a URL fragment is not
 * one either. Both follow `extractTags`, so what completes is what the index will hold.
 */

const NOTES = [
  { id: 1, name: 'Roadmap' },
  { id: 2, name: 'Launch plan' },
];

const TAGS = ['spec', 'adr'];

function at(doc: string, pos = doc.length, explicit = false): CompletionContext {
  const state = EditorState.create({
    doc,
    extensions: [noteLanguage, vaultContext.of(contextOf(NOTES, TAGS))],
  });

  return new CompletionContext(state, pos, explicit);
}

describe('note titles', () => {
  it('offers every note once the brackets are open', () => {
    const result = wikilinkSource(at('see [['));

    expect(result?.options.map((option) => option.label)).toEqual(['Roadmap', 'Launch plan']);
  });

  // A title two notes carry cannot say which is meant, so the offer is the path — the same
  // target the graph would resolve them apart by.
  it('offers a repeated title by path', () => {
    const shared = [
      { id: 1, name: 'CLAUDE.md', path: 'projects/shelf/CLAUDE.md' },
      { id: 2, name: 'CLAUDE.md', path: 'projects/atlas/CLAUDE.md' },
      { id: 3, name: 'Roadmap', path: 'Roadmap' },
    ];

    const state = EditorState.create({
      doc: 'see [[',
      extensions: [noteLanguage, vaultContext.of(contextOf(shared, TAGS))],
    });

    const result = wikilinkSource(new CompletionContext(state, 6, false));

    expect(result?.options.map((option) => option.label)).toEqual([
      'projects/shelf/CLAUDE.md',
      'projects/atlas/CLAUDE.md',
      'Roadmap',
    ]);
  });

  it('starts the replacement after the brackets, so typing filters', () => {
    const result = wikilinkSource(at('see [[Road'));

    expect(result?.from).toBe(6);
  });

  it('stays quiet outside a link', () => {
    expect(wikilinkSource(at('just prose'))).toBeNull();
    expect(wikilinkSource(at('a [single'))).toBeNull();
  });

  it('stops at the closing bracket rather than running past it', () => {
    expect(wikilinkSource(at('[[a]] then'))).toBeNull();
  });
});

describe('tags', () => {
  it('offers the vault tags once there is something to match on', () => {
    const result = tagSource(at('note #s'));

    expect(result?.options.map((option) => option.label)).toEqual(['spec', 'adr']);
    expect(result?.from).toBe(6);
  });

  // `#` at the start of a line is how every heading begins; popping a tag list there would
  // fire on the way to writing one.
  it('says nothing to a bare hash', () => {
    expect(tagSource(at('#'))).toBeNull();
    expect(tagSource(at('# '))).toBeNull();
  });

  it('offers the list anyway when the completion was asked for', () => {
    expect(tagSource(at('#', 1, true))?.options).toHaveLength(2);
  });

  it('ignores a fragment glued to a word, the way a URL has one', () => {
    expect(tagSource(at('https://x.dev/page#anchor'))).toBeNull();
  });
});
