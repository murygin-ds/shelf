import { useCallback, useEffect, useRef } from 'react';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
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

import { editorTheme, livePreview } from './livepreview';

/**
 * Marks a document swap this component performed — a body that arrived from the server
 * rather than from the keyboard. `editBody` sets `dirty` and clears `conflict`
 * unconditionally, so echoing a pulled body back through it would mark the note unsaved and
 * dismiss the conflict banner without the reader having chosen anything.
 */
const External = Annotation.define<boolean>();

const editable = new Compartment();
const undoStack = new Compartment();

export interface MarkdownEditorProps {
  /** The body as the store holds it. Deliberately not a controlled value — see below. */
  value: string;
  /** A change here means a different note: new document, and no undo history carried over. */
  docId: number;
  readOnly: boolean;
  placeholder: string;
  onChange: (body: string) => void;
  onBlur: () => void;
  className?: string | undefined;
}

export function MarkdownEditor({
  value,
  docId,
  readOnly,
  placeholder,
  onChange,
  onBlur,
  className,
}: MarkdownEditorProps) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);

  // The shell subscribes to the whole store, so every unrelated write hands this component
  // new callback identities. Reading them through a ref keeps the editor out of every
  // dependency array, which is what stops an unrelated re-render from resetting the
  // document under the caret.
  const latest = useRef({ value, readOnly, placeholder, onChange, onBlur });
  latest.current = { value, readOnly, placeholder, onChange, onBlur };

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
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown({ base: markdownLanguage }),
        livePreview,
        editorTheme,
        EditorView.lineWrapping,
        EditorView.contentAttributes.of({ spellcheck: 'false', 'aria-label': 'Note body' }),
        editable.of(gate(latest.current.readOnly, latest.current.placeholder)),
        EditorView.domEventHandlers({
          // A microtask rather than a synchronous call: the composed text is applied after
          // the event, and dispatching from inside an update is not allowed.
          compositionend: () => {
            queueMicrotask(drain);
            return false;
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

  return <div ref={host} className={className} />;
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
