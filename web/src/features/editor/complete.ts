import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';

import { vaultContext } from './context';

/**
 * What the editor can offer while someone is typing, which here is only ever things the
 * reader already holds the key to: note titles and tags that exist in this vault. Nothing
 * is fetched — the list comes off the facet, which is the decrypted tree this device has.
 */

const LINK = /\[\[[^\]\n|]*/;
const TAG = /#[\p{L}\p{N}_-]*/u;

export function wikilinkSource(context: CompletionContext): CompletionResult | null {
  const typed = context.matchBefore(LINK);
  if (!typed) return null;

  const notes = context.state.facet(vaultContext).notes;
  if (!notes.length) return null;

  // A title more than one note carries cannot say which is meant, so those are offered by
  // path — which is the target resolution would pick them out by anyway.
  const seen = new Set<string>();
  const shared = new Set<string>();

  for (const note of notes) {
    const title = note.name.trim().toLowerCase();

    if (seen.has(title)) shared.add(title);
    seen.add(title);
  }

  return {
    from: typed.from + 2,
    options: notes.map((note) => {
      const text = shared.has(note.name.trim().toLowerCase()) ? (note.path ?? note.name) : note.name;

      return {
        label: text,
        type: 'text',
        apply: (view, _completion, from, to) => {
          // `closeBrackets` has usually already put the closing pair there. Writing a second
          // one would leave `]]]]`, and leaving none would leave half a link — which resolves
          // to nothing and shows up as an unresolved title on the inspector panel.
          const closed = view.state.doc.sliceString(to, to + 2) === ']]';

          view.dispatch({
            changes: { from, to, insert: closed ? text : `${text}]]` },
            selection: { anchor: from + text.length + 2 },
            userEvent: 'input.complete',
          });
        },
      };
    }),
    validFor: /^[^\]\n|]*$/,
  };
}

export function tagSource(context: CompletionContext): CompletionResult | null {
  const typed = context.matchBefore(TAG);
  if (!typed) return null;

  // A `#` at the start of a line is a heading, and one glued to a word is a URL fragment.
  // Both are the same rule `extractTags` applies, so what completes is what will be indexed.
  const before = context.state.doc.sliceString(Math.max(0, typed.from - 1), typed.from);
  if (before && !/\s/.test(before)) return null;

  // One bare `#` is not enough to go on: it is how every heading starts.
  if (typed.to - typed.from < 2 && !context.explicit) return null;

  const tags = context.state.facet(vaultContext).tags;
  if (!tags.length) return null;

  return {
    from: typed.from + 1,
    options: tags.map((tag) => ({ label: tag, type: 'keyword' })),
    validFor: /^[\p{L}\p{N}_-]*$/u,
  };
}
