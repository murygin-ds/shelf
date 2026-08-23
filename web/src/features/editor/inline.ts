import type { MarkdownParser } from '@lezer/markdown';

import { noteLanguage } from './language';
import { wikilinkParts } from './wikilink';

/**
 * Inline markdown, resolved into the pieces a reader sees.
 *
 * Live preview never needs this: it leaves the document's own characters on screen and
 * decorates them in place. A table cannot work that way — the whole block is replaced by a
 * real grid, so the text inside a cell is DOM somebody has to build — and without this a
 * cell is the one place in a note where `` `code` ``, `**bold**` and `[[a link]]` stay
 * exactly the characters they were written as, with no pipes left on screen to explain why.
 *
 * The split is the same one live preview makes: this says what is shown and where it came
 * from, the caller turns that into nodes. Every span's text is the source slice
 * `[from, to)`, which is what lets a click inside a rendered cell put the caret on the
 * character it landed on once the markdown comes back.
 */

export interface InlineSpan {
  /** What the reader sees. Always `source.slice(from, to)`. */
  text: string;
  from: number;
  to: number;
  code?: boolean;
  strong?: boolean;
  em?: boolean;
  strike?: boolean;
  /** A markdown link or an autolink. Styled, and no more: the URL itself is not shown. */
  link?: boolean;
  /** A `[[wikilink]]`'s target, of which this span's text is the label. */
  wiki?: string;
}

type Style = Omit<InlineSpan, 'text' | 'from' | 'to'>;

/**
 * The nodes that are markup and nothing else. A cell shows what they delimit, never them —
 * concealing rather than dimming, because unlike a line of prose a cell has no room to
 * spend on punctuation the grid already accounts for.
 */
const DROPPED = new Set(['CodeMark', 'EmphasisMark', 'StrikethroughMark', 'LinkMark', 'LinkTitle', 'LinkLabel']);

/** Constructs whose text is a label, so what they point at is not shown. */
// i18n-ignore — node names, not prose
const LABELLED = new Set(['Link', 'Image']);

const STYLED: Record<string, keyof Style> = {
  InlineCode: 'code',
  StrongEmphasis: 'strong',
  Emphasis: 'em',
  Strikethrough: 'strike',
  Link: 'link',
  Image: 'link',
  Autolink: 'link',
};

/**
 * `parseInline` rather than a parse of the whole string: a cell holds inline content, and a
 * cell that opens with `#` or `- ` means those characters — reading them as a heading or a
 * bullet would eat them off the front of the text.
 */
const parser = noteLanguage.language.parser as MarkdownParser;

/** `Element.children` is what the parser returns and what the published typings omit. */
interface Inline {
  readonly type: number;
  readonly from: number;
  readonly to: number;
  readonly children: readonly Inline[];
}

export function inlineSpans(source: string): InlineSpan[] {
  const spans: InlineSpan[] = [];

  walk(source, parser.parseInline(source, 0) as unknown as readonly Inline[], 0, source.length, {}, spans);

  return spans;
}

/**
 * The offset in the source that the rendered offset `at` points at.
 *
 * A position between two spans belongs to the one that follows it: an offset is where the
 * caret goes, and the character the reader clicked in front of is the one on the right —
 * which at the end of `**bold**` is the space after the markers, not the gap before them.
 */
export function sourceOffset(spans: readonly InlineSpan[], at: number): number {
  let seen = 0;

  for (const span of spans) {
    if (at < seen + span.text.length) return span.from + (at - seen);

    seen += span.text.length;
  }

  return spans[spans.length - 1]?.to ?? at;
}

/** Whether a span is just text, which is what nearly every cell is. */
export function isPlain(span: InlineSpan): boolean {
  return !span.code && !span.strong && !span.em && !span.strike && !span.link && span.wiki === undefined;
}

/** `labelled` says the enclosing construct has link text of its own to show instead of a url. */
function walk(
  source: string,
  nodes: readonly Inline[],
  from: number,
  to: number,
  style: Style,
  out: InlineSpan[],
  labelled = false,
): void {
  let at = from;

  for (const node of nodes) {
    if (node.from > at) push(out, source, at, node.from, style);

    visit(source, node, style, out, labelled);
    at = node.to;
  }

  if (at < to) push(out, source, at, to, style);
}

function visit(
  source: string,
  node: Inline,
  style: Style,
  out: InlineSpan[],
  labelled: boolean,
): void {
  const name = parser.nodeSet.types[node.type]?.name ?? '';

  if (DROPPED.has(name)) return;

  // Under `[text](url)` the url is the destination and the label is what to show. Anywhere
  // else — an autolink, or a bare one written straight into the cell — it is the text
  // itself, and dropping it would leave a cell holding one bookmark empty.
  if (name === 'URL') {
    if (!labelled) push(out, source, node.from, node.to, { ...style, link: true });

    return;
  }

  if (name === 'Wikilink') {
    wiki(source, node, style, out);

    return;
  }

  const styled = STYLED[name];
  const next = styled ? { ...style, [styled]: true } : style;

  if (!node.children.length) push(out, source, node.from, node.to, next);
  else walk(source, node.children, node.from, node.to, next, out, labelled || LABELLED.has(name));
}

/** The parser leaves a wikilink whole, so what to show is an offset into its own text. */
function wiki(source: string, node: Inline, style: Style, out: InlineSpan[]): void {
  const text = source.slice(node.from, node.to);
  const { target, hidden } = wikilinkParts(text);
  const cuts = [...hidden].sort((a, b) => a[0] - b[0]);

  let at = 0;

  for (const [from, to] of cuts) {
    if (from > at) push(out, source, node.from + at, node.from + from, { ...style, wiki: target });

    at = Math.max(at, to);
  }

  if (at < text.length) push(out, source, node.from + at, node.to, { ...style, wiki: target });
}

function push(out: InlineSpan[], source: string, from: number, to: number, style: Style): void {
  if (from >= to) return;

  out.push({ ...style, text: source.slice(from, to), from, to });
}
