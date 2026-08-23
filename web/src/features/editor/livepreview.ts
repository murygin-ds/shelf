import { syntaxTree } from '@codemirror/language';
import type { EditorState, Line, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

import { resolveTarget } from '@/lib/wikilinks';

import { vaultContext } from './context';
import { wikilinkParts } from './wikilink';

/**
 * Live preview for markdown, in the shape people expect from a notes app: the document is
 * always editable and always rendered. A heading is a heading the moment the caret leaves
 * its line, and its `#` comes back the moment the caret returns.
 *
 * Everything here is line, mark and inline-replace decorations. Nothing produces HTML — the
 * characters on screen are the document's own text nodes — so there is no sanitising to get
 * wrong and no way for a note body to become markup.
 */

export interface Span {
  from: number;
  to: number;
}

const HEADING: Record<string, string> = {
  ATXHeading1: 'cm-md-h1',
  ATXHeading2: 'cm-md-h2',
  ATXHeading3: 'cm-md-h3',
  ATXHeading4: 'cm-md-h4',
  ATXHeading5: 'cm-md-h5',
  ATXHeading6: 'cm-md-h6',
  SetextHeading1: 'cm-md-h1',
  SetextHeading2: 'cm-md-h2',
};

const INLINE: Record<string, string> = {
  StrongEmphasis: 'cm-md-strong',
  Emphasis: 'cm-md-em',
  Strikethrough: 'cm-md-strike',
  InlineCode: 'cm-md-code',
  Link: 'cm-md-link',
  Image: 'cm-md-link',
  Autolink: 'cm-md-link',
};

/**
 * The lines whose raw markdown stays visible. Every selection range counts, and a range
 * spanning lines reveals all of them: a selection being dragged across a heading should show
 * what it is actually selecting. An unfocused editor has no raw lines at all, so clicking
 * away renders the note completely.
 */
function cursorSpans(view: EditorView): Span[] {
  if (!view.hasFocus) return [];

  return view.state.selection.ranges.map((range) => ({ from: range.from, to: range.to }));
}

function isRaw(spans: readonly Span[], line: Line): boolean {
  return spans.some((span) => span.from <= line.to && span.to >= line.from);
}

/**
 * Whether the caret is anywhere inside a whole block, rather than merely on one of its
 * lines. A fenced block is edited as a unit — the fence has to stay put while the caret is
 * three lines down inside it, or it would flicker in and out on every arrow key.
 */
function within(spans: readonly Span[], node: { from: number; to: number } | null): boolean {
  if (!node) return true;

  return spans.some((span) => span.from <= node.to && span.to >= node.from);
}

export interface Built {
  decorations: DecorationSet;
  /** Only the concealed ranges, so arrow keys step over hidden markup in one press. */
  hidden: DecorationSet;
}

/**
 * Split out from the plugin so the part with all the judgement in it can be exercised
 * without a DOM: given a document, what is visible and where the caret is, this says what
 * gets styled and what gets hidden.
 */
export function buildDecorations(
  state: EditorState,
  visibleRanges: readonly Span[],
  spans: readonly Span[],
): Built {
  const tree = syntaxTree(state);

  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];

  /** Line decorations must be empty ranges anchored at the line start. */
  const line = (at: number, cls: string) => {
    all.push(Decoration.line({ class: cls }).range(state.doc.lineAt(at).from));
  };

  /**
   * `node` is the block's true extent and `visible` the slice on screen. The edge classes
   * are decided by the former: a viewport boundary landing inside a fenced block would
   * otherwise round off its corners in the middle of the code.
   */
  const block = (node: Span, visible: Span, cls: string, edges?: [string, string]) => {
    const first = state.doc.lineAt(node.from).number;
    const last = state.doc.lineAt(node.to).number;

    const start = Math.max(node.from, visible.from);
    const end = Math.min(node.to, visible.to);

    for (let pos = start; pos <= end; ) {
      const at = state.doc.lineAt(pos);

      line(at.from, cls);
      if (edges && at.number === first) line(at.from, edges[0]);
      if (edges && at.number === last) line(at.from, edges[1]);

      pos = at.to + 1;
    }
  };

  const mark = (from: number, to: number, cls: string) => {
    if (from >= to) return;

    all.push(Decoration.mark({ class: cls }).range(from, to));
  };

  const conceal = (from: number, to: number) => {
    if (from >= to) return;

    const deco = Decoration.replace({});
    all.push(deco.range(from, to));
    hidden.push(deco.range(from, to));
  };

  /** Off the caret's line the marker is gone; on it, it is dim punctuation. */
  const marker = (from: number, to: number, raw: boolean) => {
    if (raw) mark(from, to, 'cm-md-marker');
    else conceal(from, to);
  };

  for (const range of visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.name;

        const heading = HEADING[name];
        if (heading) {
          block(node, range, heading);
          return;
        }

        if (name === 'Blockquote') {
          block(node, range, 'cm-md-quote');
          return;
        }

        if (name === 'ListItem') {
          line(node.from, 'cm-md-li');
          return;
        }

        if (name === 'FencedCode' || name === 'CodeBlock') {
          block(node, range, 'cm-md-codeline', ['cm-md-codefirst', 'cm-md-codelast']);
          return;
        }

        if (name === 'Table') {
          block(node, range, 'cm-md-table');
          return;
        }

        if (name === 'TableHeader') {
          line(node.from, 'cm-md-thead');
          return;
        }

        // The whole `|---|---|` line is one node, and so is every `|` inside a row. Both are
        // scaffolding the reader does not need to read, but neither may be concealed: the
        // pipes are what the columns are made of.
        if (name === 'TableDelimiter') {
          mark(node.from, node.to, 'cm-md-marker');
          return;
        }

        // Taken whole rather than through child nodes: the parser leaves a wikilink as a
        // single node, and everything to hide inside it is an offset into its own text.
        if (name === 'Wikilink') {
          const text = state.doc.sliceString(node.from, node.to);
          const { target, hidden: cuts } = wikilinkParts(text);
          const known = resolveTarget(target, state.facet(vaultContext).targets) !== undefined;

          mark(node.from, node.to, known ? 'cm-md-wiki' : 'cm-md-wiki cm-md-wiki-missing');

          const showing = isRaw(spans, state.doc.lineAt(node.from));
          for (const [from, to] of cuts) marker(node.from + from, node.from + to, showing);

          return;
        }

        const inline = INLINE[name];
        if (inline) {
          // Descends on purpose: the markers inside still have to be dealt with.
          mark(node.from, node.to, inline);
          return;
        }

        // A bullet is never concealed — dropping it collapses the indent it creates.
        if (name === 'ListMark' || name === 'TaskMarker') {
          mark(node.from, node.to, 'cm-md-marker');
          return;
        }

        const at = state.doc.lineAt(node.from);
        const raw = isRaw(spans, at);

        switch (name) {
          case 'HorizontalRule':
            line(at.from, 'cm-md-hr');
            marker(node.from, node.to, raw);
            return;

          case 'HeaderMark': {
            // A setext heading's marker is the ===/--- line under it. Removing a whole line
            // is a block operation, which a view plugin may not do, so it stays and is
            // dimmed instead.
            if (node.matchContext(['SetextHeading1']) || node.matchContext(['SetextHeading2'])) {
              mark(node.from, node.to, 'cm-md-marker');
              return;
            }

            if (node.from === at.from) {
              // Leading run of #, plus the single space after it.
              const pad = state.doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0;
              marker(node.from, Math.min(node.to + pad, at.to), raw);
            } else {
              // The optional closing run, plus the space before it.
              const pad = state.doc.sliceString(node.from - 1, node.from) === ' ' ? 1 : 0;
              marker(node.from - pad, node.to, raw);
            }

            return;
          }

          case 'QuoteMark': {
            const pad = state.doc.sliceString(node.to, node.to + 1) === ' ' ? 1 : 0;

            marker(node.from, Math.min(node.to + pad, at.to), raw);
            return;
          }

          case 'EmphasisMark':
          case 'StrikethroughMark':
            marker(node.from, node.to, raw);
            return;

          case 'CodeMark':
            if (node.matchContext(['InlineCode'])) {
              marker(node.from, node.to, raw);
              return;
            }

            // A fence is scaffolding: once the block is finished it says nothing the block's
            // own background does not. It comes back the moment the caret is anywhere inside
            // the block — including while one is being typed, when the closing fence is the
            // only thing saying where it ends.
            marker(node.from, node.to, within(spans, node.node.parent));

            return;

          // The language after the opening fence. Hidden with it, and for the same reason:
          // the colours in the block already say what language it is.
          case 'CodeInfo':
            marker(node.from, node.to, within(spans, node.node.parent));

            return;

          case 'LinkMark':
          case 'LinkTitle':
          case 'LinkLabel':
            // A reference definition line is nothing but markup; concealing it blanks it.
            if (node.matchContext(['LinkReference'])) mark(node.from, node.to, 'cm-md-marker');
            else marker(node.from, node.to, raw);

            return;

          case 'URL':
            // Only where the construct has separate link text to fall back on. Inside
            // `<https://example.com>` the URL is the only text there is, and hiding it
            // alongside the angle brackets leaves an empty line; a note holding one
            // bookmark would render blank. A bare autolink emits URL straight under
            // Paragraph and is likewise the text itself.
            if (node.matchContext(['Link']) || node.matchContext(['Image'])) {
              marker(node.from, node.to, raw);
            }

            return;

          default:
            return;
        }
      },
    });
  }

  return {
    // Sorted here rather than through a RangeSetBuilder: a line decoration has the lowest
    // start side of any kind, so at a line start it has to come before every mark and
    // replace at the same offset — and the tree does not hand nodes back in that order.
    decorations: Decoration.set(all, true),
    hidden: Decoration.set(hidden, true),
  };
}

function build(view: EditorView): Built {
  return buildDecorations(view.state, view.visibleRanges, cursorSpans(view));
}

class LivePreview {
  decorations: DecorationSet;
  hidden: DecorationSet;

  constructor(view: EditorView) {
    const built = build(view);

    this.decorations = built.decorations;
    this.hidden = built.hidden;
  }

  update(update: ViewUpdate) {
    if (
      !update.docChanged &&
      !update.viewportChanged &&
      !update.focusChanged &&
      !moved(update) &&
      syntaxTree(update.state) === syntaxTree(update.startState)
    ) {
      return;
    }

    const built = build(update.view);

    this.decorations = built.decorations;
    this.hidden = built.hidden;
  }
}

/**
 * Whether the selection actually moved. `ViewUpdate.selectionSet` only says a transaction
 * set a selection explicitly, which is false for a caret carried along by a text change —
 * and the caret's line is exactly what decides what stays raw.
 */
function moved(update: ViewUpdate): boolean {
  const before = update.startState.selection.ranges;
  const after = update.state.selection.ranges;

  if (before.length !== after.length) return true;

  return after.some((range, index) => {
    const was = before[index];

    return !was || was.from !== range.from || was.to !== range.to;
  });
}

export const livePreview = ViewPlugin.fromClass(LivePreview, {
  decorations: (value) => value.decorations,
  // Only the concealed ranges. Handing over the whole set would make the inside of every
  // bold span, code span and link atomic too, and the caret would skip over them.
  provide: (plugin) =>
    EditorView.atomicRanges.of((view) => view.plugin(plugin)?.hidden ?? Decoration.none),
});

/**
 * The editor wears the app's own tokens. The body stays mono, the way the note has always
 * looked here; headings switch to the display face so a heading is unmistakably one.
 */
export const editorTheme = EditorView.theme(
  {
    // Height and scrolling belong to the surrounding .scroll container. CodeMirror still
    // virtualises against it — it measures through to the nearest scrolling ancestor.
    '&': {
      height: 'auto',
      backgroundColor: 'transparent',
      color: 'var(--text-secondary)',
      fontFamily: 'var(--font-mono)',
      fontSize: '13.5px',
    },
    '.cm-scroller': { overflow: 'visible', fontFamily: 'inherit', lineHeight: '1.85' },
    '.cm-content': {
      padding: '0',
      minHeight: '60vh',
      caretColor: 'var(--accent)',
      overflowWrap: 'anywhere',
    },
    '.cm-line': { padding: '0' },

    // The global rule exempts input/textarea/select from the focus ring, but the body is a
    // contenteditable div and would draw one the old textarea never had.
    '&.cm-focused': { outline: 'none' },
    '.cm-content:focus-visible': { boxShadow: 'none' },

    '.cm-placeholder': { color: 'var(--text-disabled)' },

    '.cm-md-h1, .cm-md-h2, .cm-md-h3, .cm-md-h4, .cm-md-h5, .cm-md-h6': {
      fontFamily: 'var(--font-sans)',
      fontWeight: '600',
      letterSpacing: '-0.018em',
      lineHeight: '1.3',
      color: 'var(--text)',
      paddingTop: '0.6em',
    },
    '.cm-md-h1': { fontSize: '25px' },
    '.cm-md-h2': { fontSize: '20px' },
    '.cm-md-h3': { fontSize: '17px' },
    '.cm-md-h4, .cm-md-h5, .cm-md-h6': { fontSize: '14.5px' },

    // One border per line adds up to a single continuous bar down the quote.
    '.cm-md-quote': {
      paddingLeft: '14px',
      borderLeft: '2px solid var(--border-strong)',
      color: 'var(--text-dim)',
    },

    // Hanging indent, so a wrapped item lines up past its bullet.
    '.cm-md-li': { paddingLeft: '1.5em', textIndent: '-1.5em' },

    '.cm-md-codeline': {
      backgroundColor: 'var(--surface-code)',
      paddingLeft: '14px',
      paddingRight: '14px',
      borderLeft: '1px solid var(--border-subtle)',
      borderRight: '1px solid var(--border-subtle)',
      color: 'var(--code-text)',
    },
    '.cm-md-codefirst': {
      paddingTop: '8px',
      borderTop: '1px solid var(--border-subtle)',
      borderTopLeftRadius: 'var(--radius-md)',
      borderTopRightRadius: 'var(--radius-md)',
    },
    '.cm-md-codelast': {
      paddingBottom: '8px',
      borderBottom: '1px solid var(--border-subtle)',
      borderBottomLeftRadius: 'var(--radius-md)',
      borderBottomRightRadius: 'var(--radius-md)',
    },

    '.cm-md-hr': { borderBottom: '1px solid var(--border)', paddingBottom: '0.8em' },

    '.cm-md-marker': { color: 'var(--text-marker)', fontWeight: '400' },
    '.cm-md-strong': { fontWeight: '700', color: 'var(--text)' },
    '.cm-md-em': { fontStyle: 'italic' },
    '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--text-dim)' },
    '.cm-md-code': {
      padding: '1px 5px',
      borderRadius: 'var(--radius-sm)',
      backgroundColor: 'var(--surface-inset)',
      color: 'var(--code-text)',
    },
    '.cm-md-link': { color: 'var(--accent)', textDecoration: 'underline', textUnderlineOffset: '2px' },

    '.cm-md-wiki': {
      color: 'var(--accent)',
      textDecoration: 'underline',
      textDecorationStyle: 'dotted',
      textUnderlineOffset: '3px',
      cursor: 'pointer',
    },
    // A link to a note that does not exist yet is an invitation, not a mistake, so it is
    // dimmed rather than coloured like a warning.
    '.cm-md-wiki-missing': {
      color: 'var(--text-dim)',
      textDecorationColor: 'var(--text-marker)',
      cursor: 'default',
    },

    // The raw rows, seen only while the caret is inside the table and it is being edited.
    '.cm-md-table': { fontVariantLigatures: 'none' },
    '.cm-md-thead': { fontWeight: '700', color: 'var(--text)' },

    // The rendered grid that stands in for them the rest of the time. The air around it is
    // padding, not margin: CodeMirror measures the widget's box, and a margin it cannot see
    // would put every line under a table out of step with where clicks land on it.
    '.cm-md-grid': {
      padding: '0.5em 0',
      fontFamily: 'var(--font-sans)',
      fontSize: '13px',
      lineHeight: '1.5',
    },
    '.cm-md-grid > table': { borderCollapse: 'collapse', width: '100%' },
    '.cm-md-grid th, .cm-md-grid td': {
      padding: '6px 10px',
      border: '1px solid var(--border)',
      verticalAlign: 'top',
    },
    '.cm-md-grid th': {
      background: 'var(--surface-inset)',
      fontWeight: '600',
      color: 'var(--text)',
    },
    '.cm-md-grid td': { color: 'var(--text-body)' },
    // An empty cell would otherwise collapse to a hairline and break the grid.
    '.cm-md-grid td:empty::after': { content: '"\\00a0"' },
    // The cells are edited in place, so the focus ring is the only thing saying which one
    // the keyboard is in. Inset rather than outlined: an outline on a collapsed border
    // doubles the grid line and the row appears to jump.
    '.cm-md-grid th:focus, .cm-md-grid td:focus': {
      outline: 'none',
      boxShadow: 'inset 0 0 0 1.5px var(--accent-focus)',
      background: 'var(--accent-wash)',
    },


    // CodeMirror's own popup, wearing the same surface as every other floating thing here.
    '.cm-tooltip.cm-tooltip-autocomplete': {
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--radius-lg)',
      background: 'var(--surface-raised)',
      boxShadow: 'var(--shadow-popover)',
      overflow: 'hidden',
    },
    '.cm-tooltip-autocomplete > ul': {
      maxHeight: '15em',
      fontFamily: 'var(--font-mono)',
      fontSize: '12px',
    },
    '.cm-tooltip-autocomplete > ul > li': {
      padding: '5px 10px',
      color: 'var(--text-body)',
      lineHeight: '1.5',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      background: 'var(--accent-wash)',
      color: 'var(--text)',
    },
    '.cm-completionIcon': { display: 'none' },
  },
  { dark: true },
);
