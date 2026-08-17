import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { MarkdownConfig } from '@lezer/markdown';

/**
 * `[[Title]]` as a node the editor can see.
 *
 * Without this the markdown parser reads the inner pair of brackets as a shortcut reference
 * link, live preview hides one bracket from each side as link markup, and the reader is left
 * looking at `[Title]` — a link that is neither styled nor clickable, and whose text has
 * quietly lost a character at both ends.
 *
 * Registering before `Link` is the whole trick: the first parser to claim the `[` wins, so
 * the reference-link reading never happens.
 */

const OPEN = 91; /* [ */
const CLOSE = 93; /* ] */
const PIPE = 124; /* | */
const NEWLINE = 10;

export const Wikilink: MarkdownConfig = {
  defineNodes: ['Wikilink'],
  parseInline: [
    {
      name: 'Wikilink',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== OPEN || cx.char(pos + 1) !== OPEN) return -1;

        const start = pos + 2;
        let at = start;
        let pipe = -1;

        while (at < cx.end) {
          const char = cx.char(at);

          // The same boundaries `parseWikilinks` uses, so what the editor draws as a link and
          // what the graph records as one can never disagree.
          if (char === NEWLINE) return -1;

          if (char === CLOSE) {
            if (cx.char(at + 1) === CLOSE) break;

            return -1;
          }

          if (char === PIPE && pipe < 0) pipe = at;

          at += 1;
        }

        if (at >= cx.end || cx.char(at) !== CLOSE) return -1;

        // An empty target is not a link; `[[]]` is just four brackets.
        if (!cx.slice(start, pipe < 0 ? at : pipe).trim()) return -1;

        return cx.addElement(cx.elt('Wikilink', pos, at + 2));
      },
    },
  ],
};

export interface WikilinkParts {
  /** The title as written, trimmed. */
  target: string;
  /** What the reader should see: the alias when there is one, the target otherwise. */
  label: string;
  /** Offsets of the text to conceal, relative to the start of the node. */
  hidden: [number, number][];
}

/**
 * Splits a `[[…]]` node's own text. Live preview needs the pieces by offset rather than by
 * child node, and reading them off the string keeps the parser down to a single node.
 */
export function wikilinkParts(text: string): WikilinkParts {
  const inner = text.slice(2, -2);
  const pipe = inner.indexOf('|');

  const target = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe < 0 ? '' : inner.slice(pipe + 1).trim();

  const hidden: [number, number][] = [
    [0, 2],
    [text.length - 2, text.length],
  ];

  // With an alias the target and the bar go too; an empty alias is not one, so only the bar
  // and the space after it are dropped and the target stays on screen.
  if (pipe >= 0) hidden.push(alias ? [2, pipe + 3] : [pipe + 2, text.length - 2]);

  return { target, label: alias || target, hidden };
}

export interface WikilinkAt {
  target: string;
  from: number;
  to: number;
}

/** The link covering `pos`, for a pointer that has just landed somewhere in the document. */
export function wikilinkAt(state: EditorState, pos: number): WikilinkAt | null {
  if (pos < 0 || pos > state.doc.length) return null;

  let node = syntaxTree(state).resolveInner(pos, 1);

  while (node.name !== 'Wikilink') {
    const parent: typeof node | null = node.parent;

    if (!parent) return null;

    node = parent;
  }

  const { target } = wikilinkParts(state.doc.sliceString(node.from, node.to));

  return { target, from: node.from, to: node.to };
}
