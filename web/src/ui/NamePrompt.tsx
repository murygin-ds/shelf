import { type FormEvent, type ReactElement, useCallback, useEffect, useRef, useState } from 'react';

import { useDismiss } from './dismiss';
import styles from './nameprompt.module.css';

interface Request {
  label: string;
  initial: string;
  resolve: (name: string | null) => void;
}

/**
 * Asks for a name without a native dialog.
 *
 * `window.prompt` was doing this job, and it has one failure mode that matters here: a
 * browser that has been told to suppress dialogs — Chrome offers exactly that after a few
 * in a row — returns null with no warning. Creating a folder then silently does nothing,
 * which is indistinguishable from the app being broken.
 *
 * The shape mirrors the thing it replaces: `await ask(...)` returns the name or null, and
 * `dialog` is rendered wherever the caller likes.
 */
export function useNamePrompt(): {
  ask: (label: string, initial: string) => Promise<string | null>;
  dialog: ReactElement | null;
} {
  const [request, setRequest] = useState<Request | null>(null);

  const ask = useCallback(
    (label: string, initial: string) =>
      new Promise<string | null>((resolve) => setRequest({ label, initial, resolve })),
    [],
  );

  const close = (name: string | null) => {
    request?.resolve(name);
    setRequest(null);
  };

  const dialog = request ? (
    <NamePrompt key={request.label} request={request} onClose={close} />
  ) : null;

  return { ask, dialog };
}

function NamePrompt({ request, onClose }: { request: Request; onClose: (name: string | null) => void }) {
  const [value, setValue] = useState(request.initial);
  const dismiss = useDismiss(() => onClose(null));
  const field = useRef<HTMLInputElement | null>(null);

  // Renaming almost always means replacing the whole name, so the suggestion comes up
  // selected and typing overwrites it. Done here rather than through `autoFocus` and an
  // onFocus handler: React focuses the node during commit, and the selection that sets does
  // not survive it.
  useEffect(() => {
    field.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();

    // An empty box means the suggestion, the way a native prompt's pre-filled value does.
    onClose(value.trim() || request.initial);
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <form className={styles.card} onSubmit={submit}>
        <label className={styles.label} htmlFor="name-prompt">
          {request.label}
        </label>

        <input
          ref={field}
          id="name-prompt"
          className={styles.input}
          value={value}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose(null);
          }}
        />

        <div className={styles.actions}>
          <button type="button" className={styles.cancel} onClick={() => onClose(null)}>
            Cancel
          </button>
          <button type="submit" className={styles.confirm}>
            OK
          </button>
        </div>
      </form>
    </div>
  );
}
