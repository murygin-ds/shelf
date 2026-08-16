import { syntaxTree } from '@codemirror/language';
import type { Line, Range } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';

/**
 * Live preview for markdown, in the shape people expect from a notes app: the document is
 * always editable and always rendered. A heading is a heading the moment the caret leaves
 * its line, and its `#` comes back the moment the caret returns.
 *
 * Everything here is line, mark and inline-replace decorations. Nothing produces HTML — the
 * characters on screen are the document's own text nodes — so there is no sanitising to get
 * wrong and no way for a note body to become markup.
 */

interface Span {
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

function isRaw(spans: Span[], line: Line): boolean {
  return spans.some((span) => span.from <= line.to && span.to >= line.from);
}

interface Built {
  decorations: DecorationSet;
  /** Only the concealed ranges, so arrow keys step over hidden markup in one press. */
  hidden: DecorationSet;
}

function build(view: EditorView): Built {
  const state = view.state;
  const tree = syntaxTree(state);
  const spans = cursorSpans(view);

  const all: Range<Decoration>[] = [];
  const hidden: Range<Decoration>[] = [];

  /** Line decorations must be empty ranges anchored at the line start. */
  const line = (at: number, cls: string) => {
    all.push(Decoration.line({ class: cls }).range(state.doc.lineAt(at).from));
  };

  const block = (from: number, to: number, cls: string, edges?: [string, string]) => {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;

    for (let pos = from; pos <= to; ) {
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

  for (const range of view.visibleRanges) {
    tree.iterate({
      from: range.from,
      to: range.to,
      enter: (node) => {
        const name = node.name;
        const from = Math.max(node.from, range.from);
        const to = Math.min(node.to, range.to);

        const heading = HEADING[name];
        if (heading) {
          block(from, to, heading);
          return;
        }

        if (name === 'Blockquote') {
          block(from, to, 'cm-md-quote');
          return;
        }

        if (name === 'ListItem') {
          line(node.from, 'cm-md-li');
          return;
        }

        if (name === 'FencedCode' || name === 'CodeBlock') {
          block(from, to, 'cm-md-codeline', ['cm-md-codefirst', 'cm-md-codelast']);
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
            // The backticks around a code span go. A fenced block's ``` stays: while the
            // block is being written it is the only thing saying where it ends.
            if (node.matchContext(['InlineCode'])) marker(node.from, node.to, raw);
            else mark(node.from, node.to, 'cm-md-marker');

            return;

          case 'LinkMark':
          case 'LinkTitle':
          case 'LinkLabel':
            // A reference definition line is nothing but markup; concealing it blanks it.
            if (node.matchContext(['LinkReference'])) mark(node.from, node.to, 'cm-md-marker');
            else marker(node.from, node.to, raw);

            return;

          case 'URL':
            // A bare autolink emits URL straight under Paragraph — there it is the text.
            if (
              node.matchContext(['Link']) ||
              node.matchContext(['Image']) ||
              node.matchContext(['Autolink'])
            ) {
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
  },
  { dark: true },
);
