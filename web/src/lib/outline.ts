/**
 * The map of a note: the headings of its body, in the order and the shape the panel draws
 * them.
 *
 * It is read from the plaintext the store already holds rather than from anything the server
 * knows, which is the only way it could work here — a heading is text inside a ciphertext.
 * Reading the open body also makes the map as fresh as the last keystroke instead of as the
 * last save.
 */

export interface Heading {
  /** As written: 1 through 6. What decides how large the line is drawn. */
  level: number;
  /** How far the line indents, counted from the headings above it rather than the level. */
  depth: number;
  /** The heading with its inline markup taken off. */
  text: string;
  /** 1-based, which is what the editor counts lines in. */
  line: number;
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;
/** A line that opens a block of its own, so an `===` under it underlines nothing. */
const BLOCK = /^(?: {4,}|[ \t]*(?:>|[-*+][ \t]|\d{1,9}[.)][ \t]|\||#))/;

export function outline(body: string): Heading[] {
  const lines = body.split('\n');
  const found: Heading[] = [];

  // The levels of the headings this one sits under, which is what turns 3-3-5 into two
  // siblings and a child instead of two indents and a jump of two.
  const ancestors: number[] = [];
  let fence: { mark: string; length: number } | null = null;
  let paragraph = false;

  const push = (level: number, raw: string, line: number) => {
    const text = plain(raw);
    if (!text) return;

    while (ancestors.length && ancestors[ancestors.length - 1]! >= level) ancestors.pop();

    found.push({ level, depth: ancestors.length, text, line });
    ancestors.push(level);
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const run = FENCE.exec(raw)?.[1];

    // Inside a fenced block every line is somebody's text, not structure — a shell comment
    // is the usual way a code sample would otherwise grow a heading.
    if (fence) {
      if (run && run[0] === fence.mark && run.length >= fence.length) fence = null;
      paragraph = false;
      continue;
    }

    if (run) {
      fence = { mark: run[0]!, length: run.length };
      paragraph = false;
      continue;
    }

    const atx = ATX.exec(raw);
    if (atx) {
      // The optional closing run of hashes is punctuation, not part of the title.
      push(atx[1]!.length, (atx[2] ?? '').replace(/[ \t]+#+$/, ''), index + 1);
      paragraph = false;
      continue;
    }

    // A setext underline titles the line above it, so that line is the heading — and the
    // paragraph flag is what keeps `---` under a list item or a quote from becoming one.
    if (paragraph && SETEXT.test(raw)) {
      push(raw.trimStart().startsWith('=') ? 1 : 2, lines[index - 1] ?? '', index);
      paragraph = false;
      continue;
    }

    paragraph = raw.trim().length > 0 && !BLOCK.test(raw);
  }

  return found;
}

/**
 * The heading the caret is under: the last one at or above `line`, or -1 while the caret is
 * still in whatever comes before the first heading.
 */
export function headingAt(headings: readonly Heading[], line: number): number {
  let at = -1;

  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index]!.line > line) break;

    at = index;
  }

  return at;
}

/**
 * A heading as it reads, not as it is written. Emphasis markers, backticks and link syntax
 * are noise in a list this narrow, and a wikilink is shown by its alias for the same reason
 * the editor renders it that way.
 */
function plain(text: string): string {
  return text
    .replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, alias?: string) =>
      (alias ?? target).trim(),
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();
}
