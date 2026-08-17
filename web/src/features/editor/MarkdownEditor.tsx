import { useCallback, useEffect, useRef } from 'react';

import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  Annotation,
  Compartment,
  EditorState,
  Transaction,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  keymap,
  placeholder as showPlaceholder,
  type ViewUpdate,
} from '@codemirror/view';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import type { Text as YText, UndoManager as YUndoManager } from 'yjs';

import { tagSource, wikilinkSource } from './complete';
import { vaultContext, type VaultContext } from './context';
import { formatKeymap, wrapOnType } from './format';
import { codeColours, noteLanguage } from './language';
import { editorTheme, livePreview } from './livepreview';
import { bindEditor, refresh } from './reveal';
import { tableGrid, tableMenu, type TableCellRef } from './table';
import { wikilinkAt } from './wikilink';

/**
 * Marks a document swap this component performed — a body that arrived from the server
 * rather than from the keyboard. `editBody` sets `dirty` and clears `conflict`
 * unconditionally, so echoing a pulled body back through it would mark the note unsaved and
 * dismiss the conflict banner without the reader having chosen anything.
 */
const External = Annotation.define<boolean>();

const editable = new Compartment();
const undoStack = new Compartment();
const vault = new Compartment();

export type LinkWhere = 'here' | 'tab';

/**
 * The live document behind this note, when one is up.
 *
 * With it the editor stops being the owner of the text: the Y.Text is, and the store hears
 * about changes from the room rather than from here. It also stops keeping its own undo
 * history — a local one would let ⌘Z take back somebody else's sentence — and hands that
 * to Y.UndoManager, which only ever undoes what this client wrote.
 */
export interface CollabBinding {
  text: YText;
  awareness: Awareness;
  undoManager: YUndoManager;
}

export interface MarkdownEditorProps {
  /** The body as the store holds it. Deliberately not a controlled value — see below. */
  value: string;
  /** A change here means a different note: new document, and no undo history carried over. */
  docId: number;
  /** Present while a live editing session is up. Absent is the old, solitary behaviour. */
  collab?: CollabBinding | undefined;
  readOnly: boolean;
  placeholder: string;
  /** The notes and tags around this one, for resolving links and for completion. */
  context: VaultContext;
  onChange: (body: string) => void;
  onBlur: () => void;
  onOpenLink: (target: string, where: LinkWhere) => void;
  /** False when it has nothing to offer, which hands the event back to the platform menu. */
  onContextMenu: (event: MouseEvent, view: EditorView, pos: number) => boolean;
  /** The right button inside a rendered table, which has its own verbs. */
  onTableMenu: (event: MouseEvent, ref: TableCellRef) => void;
  className?: string | undefined;
}

export function MarkdownEditor({
  value,
  docId,
  collab,
  readOnly,
  placeholder,
  context,
  onChange,
  onBlur,
  onOpenLink,
  onContextMenu,
  onTableMenu,
  className,
}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);

  // The shell subscribes to the whole store, so every unrelated write hands this component
  // new callback identities. Reading them through a ref keeps the editor out of every
  // dependency array, which is what stops an unrelated re-render from resetting the
  // document under the caret.
  const latest = useRef({
    value,
    collab,
    readOnly,
    placeholder,
    context,
    onChange,
    onBlur,
    onOpenLink,
    onContextMenu,
    onTableMenu,
  });
  latest.current = {
    value,
    collab,
    readOnly,
    placeholder,
    context,
    onChange,
    onBlur,
    onOpenLink,
    onContextMenu,
    onTableMenu,
  };

  /** A body that arrived while an IME held the document, waiting for the composition to end. */
  const deferred = useRef<string | null>(null);

  const stateFor = useCallback((doc: string) => {
    const room = latest.current.collab;

    const listen = (update: ViewUpdate) => {
      // The outline marks the heading at the top of the viewport, and text arriving above
      // the fold moves it without any scrolling. Before the room check: what is on screen is
      // a fact about this editor, whoever is writing the text.
      if (update.docChanged || update.geometryChanged) refresh();

      // With a live session the room reports the text, because it also has to report the
      // edits that arrive from other people — and those never pass through here.
      if (room) {
        if (update.focusChanged && !update.view.hasFocus) latest.current.onBlur();
        return;
      }

      // Only real edits reach the store; without the annotation check our own sync-back
      // would come straight back in as a user edit.
      if (update.docChanged && !update.transactions.some((tr) => tr.annotation(External))) {
        latest.current.onChange(update.state.doc.toString());
      }

      // CodeMirror's own focus tracking rather than React's onBlur: a blur on the wrapper
      // fires for anything inside the editor taking focus, and each one was a network write.
      if (update.focusChanged && !update.view.hasFocus) latest.current.onBlur();
    };

    const drain = () => {
      const instance = view.current;
      const next = deferred.current;

      if (!instance || next === null || instance.composing) return;

      deferred.current = null;
      swap(instance, next);
    };

    return EditorState.create({
      // With a room the Y.Text is the document, so the state starts from what it holds
      // rather than from the store's copy. yCollab only relays changes from here on — it
      // does not fill the editor — so starting empty would leave the note blank until
      // somebody typed, and every edit would then be positioned against text CodeMirror
      // could not see.
      doc: room ? room.text.toString() : doc,
      extensions: [
        // A shared document has no local history. ⌘Z on one would take back whatever the
        // stack happened to hold, including somebody else's sentence; Y.UndoManager undoes
        // only what this client wrote.
        undoStack.of(room ? [] : history()),
        room ? yCollab(room.text, room.awareness, { undoManager: room.undoManager }) : [],
        // Ours first: ⌘B and the wrapping markers have to win over whatever the defaults
        // would otherwise do with the same key.
        wrapOnType,
        closeBrackets(),
        autocompletion({ override: [wikilinkSource, tagSource] }),
        keymap.of([
          ...formatKeymap,
          ...closeBracketsKeymap,
          // Before the defaults, or the arrow keys move the caret out from under the open
          // list and Escape reaches `simplifySelection` instead of closing it.
          ...completionKeymap,
          ...defaultKeymap,
          ...(room ? yUndoManagerKeymap : historyKeymap),
        ]),
        noteLanguage,
        codeColours,
        livePreview,
        tableGrid,
        // Read through the ref, so the handler never has to be reconfigured.
        tableMenu.of((event, ref) => latest.current.onTableMenu(event, ref)),
        editorTheme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'Note body' }),
        editable.of(gate(latest.current.readOnly, latest.current.placeholder)),
        vault.of(vaultContext.of(latest.current.context)),
        EditorView.domEventHandlers({
          // A microtask rather than a synchronous call: the composed text is applied after
          // the event, and dispatching from inside an update is not allowed.
          compositionend: () => {
            queueMicrotask(drain);
            return false;
          },

          // Middle-click opens a link in another tab. The mousedown has to be swallowed as
          // well, or the browser starts its own autoscroll on the way to the click.
          mousedown: (event, instance) => {
            if (event.button !== 1) return false;

            const link = linkUnder(instance, event);
            if (!link) return false;

            event.preventDefault();
            latest.current.onOpenLink(link.target, 'tab');

            return true;
          },

          click: (event, instance) => {
            if (event.button !== 0) return false;

            // A drag that ended on a link is a text selection, not a request to leave.
            if (!instance.state.selection.main.empty) return false;

            const link = linkUnder(instance, event);
            if (!link) return false;

            event.preventDefault();
            latest.current.onOpenLink(link.target, event.metaKey || event.ctrlKey ? 'tab' : 'here');

            return true;
          },

          contextmenu: (event, instance) => {
            const coords = { x: event.clientX, y: event.clientY };

            // In its precise mode `posAtCoords` answers null for a line whose range touches
            // the edge of the rendered viewport — an empty document, and the blank last line
            // every note carries while it is being written. Those are the two places the
            // menu was silently missing, so the estimate stands in, and the caret behind it.
            const at =
              instance.posAtCoords(coords) ??
              instance.posAtCoords(coords, false) ??
              instance.state.selection.main.head;

            // A right-click away from the selection moves the caret first, so the menu acts
            // on what was clicked rather than on what happened to be selected before.
            const { from, to } = instance.state.selection.main;
            if (at < from || at > to) instance.dispatch({ selection: { anchor: at } });

            return latest.current.onContextMenu(event, instance, at);
          },
        }),
        EditorView.updateListener.of(listen),
      ],
    });
  }, []);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const instance = new EditorView({ parent, state: stateFor(latest.current.value) });

    view.current = instance;
    bindEditor(instance);

    return () => {
      instance.destroy();
      view.current = null;
      deferred.current = null;
      bindEditor(null);
    };
  }, [stateFor]);

  // A different note, or a room appearing under the same one. Declared before the value
  // effect on purpose: React runs effects in order, and a note switch moves docId and value
  // in the same commit — this rebuilds the state, and the value effect then finds the
  // document already equal and does nothing.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }

    const instance = view.current;
    if (!instance) return;

    // A fresh state, not just a fresh document: replacing the text alone would carry the
    // undo stack across notes, and one ⌘Z would paste the previous note into this one —
    // which `editBody` would then mark dirty and save.
    instance.setState(stateFor(latest.current.value));
    deferred.current = null;
    // A different note under the same editor, which `setState` notifies nobody about.
    refresh();
  }, [docId, collab, stateFor]);

  // An external body. The dependency is the STRING: the store hands out a new `open` object
  // on nearly every tick with the body unchanged, and keying on the object would throw away
  // the document, the history and the caret on every poll.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;

    // With a room the Y.Text is the document. Writing the store's copy over it would undo
    // whatever arrived between the two, and every remote edit would fight the write-back.
    if (collab) return;

    // Compared against the document itself, so our own keystroke arriving back through the
    // store is a no-op and the caret never moves.
    if (instance.state.doc.toString() === value) return;

    // Never rewrite the document under a live composition: it aborts the IME and can
    // duplicate characters.
    if (instance.composing) {
      deferred.current = value;
      return;
    }

    swap(instance, value);
  }, [value, collab]);

  useEffect(() => {
    view.current?.dispatch({ effects: editable.reconfigure(gate(readOnly, placeholder)) });
  }, [readOnly, placeholder]);

  // Through a facet rather than a ref: whether a link resolves decides how it is drawn, and
  // a decoration only changes in response to a transaction. A renamed note would otherwise
  // keep looking unresolved until the next keystroke.
  useEffect(() => {
    view.current?.dispatch({ effects: vault.reconfigure(vaultContext.of(context)) });
  }, [context]);

  return <div ref={host} className={className} />;
}

function linkUnder(instance: EditorView, event: MouseEvent) {
  const at = instance.posAtCoords({ x: event.clientX, y: event.clientY });

  return at === null ? null : wikilinkAt(instance.state, at);
}

/**
 * Both facets, and neither implies the other: `readOnly` is what editing commands consult,
 * `editable` is what drops the contenteditable attribute and the caret with it.
 */
function gate(readOnly: boolean, text: string): Extension {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    showPlaceholder(text),
  ];
}

function swap(instance: EditorView, next: string) {
  const head = Math.min(instance.state.selection.main.head, next.length);

  instance.dispatch({
    changes: { from: 0, to: instance.state.doc.length, insert: next },
    selection: { anchor: head },
    annotations: [External.of(true), Transaction.addToHistory.of(false)],
    scrollIntoView: false,
  });

  // The local text is gone by someone else's decision — "Discard mine and reload". An undo
  // that brought it back would be written over the server's copy under the sequence number
  // just fetched, which is the conflict the banner exists to resolve, re-armed silently.
  // Two dispatches: reconfiguring away and back inside one transaction is a no-op.
  instance.dispatch({ effects: undoStack.reconfigure([]) });
  instance.dispatch({ effects: undoStack.reconfigure(history()) });
}
