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

import { tagSource, wikilinkSource } from './complete';
import { vaultContext, type VaultContext } from './context';
import { formatKeymap, wrapOnType } from './format';
import { codeColours, noteLanguage } from './language';
import { editorTheme, livePreview } from './livepreview';
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

export interface MarkdownEditorProps {
  /** The body as the store holds it. Deliberately not a controlled value — see below. */
  value: string;
  /** A change here means a different note: new document, and no undo history carried over. */
  docId: number;
  readOnly: boolean;
  placeholder: string;
  /** The notes and tags around this one, for resolving links and for completion. */
  context: VaultContext;
  onChange: (body: string) => void;
  onBlur: () => void;
  onOpenLink: (target: string, where: LinkWhere) => void;
  onContextMenu: (event: MouseEvent, view: EditorView, pos: number) => void;
  /** The right button inside a rendered table, which has its own verbs. */
  onTableMenu: (event: MouseEvent, ref: TableCellRef) => void;
  className?: string | undefined;
}

export function MarkdownEditor({
  value,
  docId,
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
    const listen = (update: ViewUpdate) => {
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
      doc,
      extensions: [
        undoStack.of(history()),
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
          ...historyKeymap,
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
            const at = instance.posAtCoords({ x: event.clientX, y: event.clientY });
            if (at === null) return false;

            // A right-click away from the selection moves the caret first, so the menu acts
            // on what was clicked rather than on what happened to be selected before.
            const { from, to } = instance.state.selection.main;
            if (at < from || at > to) instance.dispatch({ selection: { anchor: at } });

            latest.current.onContextMenu(event, instance, at);

            return true;
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

    return () => {
      instance.destroy();
      view.current = null;
      deferred.current = null;
    };
  }, [stateFor]);

  // A different note. Declared before the value effect on purpose: React runs effects in
  // order, and a note switch moves docId and value in the same commit — this rebuilds the
  // state, and the value effect then finds the document already equal and does nothing.
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
  }, [docId, stateFor]);

  // An external body. The dependency is the STRING: the store hands out a new `open` object
  // on nearly every tick with the body unchanged, and keying on the object would throw away
  // the document, the history and the caret on every poll.
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;

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
  }, [value]);

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
