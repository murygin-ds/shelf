import { EditorView } from '@codemirror/view';

/**
 * What part of the open note is on screen, and how to bring another part into it.
 *
 * Deliberately a module of its own rather than another field on the workspace store: this is
 * the editor's view, which is a DOM object with a lifetime of its own, and the store holds
 * the note — the body, the tabs, the keyring. There is exactly one editor on screen, so the
 * one binding here is the whole of the state.
 *
 * What it publishes is the line at the top of the viewport rather than the line under the
 * caret. Reading is what the map is for, and reading is scrolling: the caret stays where it
 * was left, three screens back, while the reader is somewhere else entirely.
 */

/** How far below the top edge the line is read from — inside the first line, not on its rim. */
const PROBE_PX = 24;

/** Where a revealed line lands. Above the probe, so a click marks the heading it opened. */
const REVEAL_PX = 12;

let editor: EditorView | null = null;
let scroller: HTMLElement | null = null;
let top = 1;
let frame = 0;
const watchers = new Set<() => void>();

/** Called by the editor as it mounts and unmounts. Null while no note is open. */
export function bindEditor(view: EditorView | null): void {
  release();
  editor = view;

  if (!view) {
    publish(1);
    return;
  }

  scroller = scrollParent(view.dom);
  (scroller ?? window).addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);

  schedule();
}

/**
 * The editor's geometry moved for a reason no scroll event reports: text typed above the
 * fold, a note swapped in, a table drawn where raw rows were.
 */
export function refresh(): void {
  schedule();
}

/** The line at the top of the viewport, 1-based. */
export function topLine(): number {
  return top;
}

export function watchTopLine(listener: () => void): () => void {
  watchers.add(listener);
  // The first watcher arrives after a scroll nobody was measuring, so it gets an answer
  // rather than whatever the number happened to be when the panel was last open.
  schedule();

  return () => {
    watchers.delete(listener);
  };
}

/**
 * Scrolls the open note until `line` sits just under the top edge.
 *
 * Nothing else moves — not the caret, not the focus. A jump through the map is a way of
 * looking at the note, and in a live session moving the caret would drag this reader's
 * cursor across everybody else's screen.
 */
export function revealLine(line: number): void {
  const view = editor;
  if (!view) return;

  const at = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));

  view.dispatch({ effects: EditorView.scrollIntoView(at.from, { y: 'start', yMargin: REVEAL_PX }) });
  schedule();
}

function release(): void {
  if (scroller) scroller.removeEventListener('scroll', schedule);
  else if (editor) window.removeEventListener('scroll', schedule);

  if (editor) window.removeEventListener('resize', schedule);

  cancelAnimationFrame(frame);
  frame = 0;
  scroller = null;
  editor = null;
}

/**
 * One measurement per frame at most: a scroll fires on every wheel notch, and the answer
 * cannot change more often than the screen does. Nothing is measured while the map is
 * closed — with no watcher there is nobody the number could reach.
 */
function schedule(): void {
  if (!editor || frame || watchers.size === 0) return;

  frame = requestAnimationFrame(() => {
    frame = 0;
    measure();
  });
}

function measure(): void {
  const view = editor;
  if (!view) return;

  // Through the line block rather than through `posAtCoords`: this is the same vertical map
  // CodeMirror scrolls by, so it answers for lines the DOM has not rendered and cannot miss
  // between two of them. A document that starts below the edge gives a negative offset,
  // which lands on the first block — the top of the note, which is where the reader is.
  const edge = (scroller?.getBoundingClientRect().top ?? 0) + PROBE_PX;
  const block = view.lineBlockAtHeight(edge - view.documentTop);

  publish(view.state.doc.lineAt(block.from).number);
}

function publish(line: number): void {
  if (line === top) return;

  top = line;
  for (const watcher of watchers) watcher();
}

/**
 * The editor scrolls nothing of its own — height and overflow belong to the pane around it,
 * so the element to listen to is whichever ancestor took that job.
 */
function scrollParent(node: HTMLElement): HTMLElement | null {
  for (let element = node.parentElement; element; element = element.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(element).overflowY)) return element;
  }

  return null;
}
