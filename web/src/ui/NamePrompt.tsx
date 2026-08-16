import { type FormEvent, type ReactElement, useCallback, useEffect, useId, useRef, useState } from 'react';

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
    <NamePrompt
      key={request.label}
      label={request.label}
      initial={request.initial}
      onSubmit={close}
      onCancel={() => close(null)}
    />
  ) : null;

  return { ask, dialog };
}

export function NamePrompt({
  label,
  initial,
  hint,
  error,
  confirmLabel = 'OK',
  busy = false,
  onSubmit,
  onCancel,
}: {
  label: string;
  initial: string;
  hint?: string;
  error?: string | null;
  confirmLabel?: string;
  /** Keeps a slow create from being fired twice. */
  busy?: boolean;
  onSubmit: (name: string) => void;
  /** Left out when an answer is required: no Cancel, no Escape, no backdrop dismissal. */
  onCancel?: () => void;
}) {
  const [value, setValue] = useState(initial);
  const dismiss = useDismiss(() => onCancel?.());
  const field = useRef<HTMLInputElement | null>(null);
  const fieldId = useId();

  // Renaming almost always means replacing the whole name, so the suggestion comes up
  // selected and typing overwrites it. Done here rather than through `autoFocus` and an
  // onFocus handler: React focuses the node during commit, and the selection that sets does
  // not survive it.
  useEffect(() => {
    field.current?.select();
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;

    // An empty box means the suggestion, the way a native prompt's pre-filled value does.
    onSubmit(value.trim() || initial);
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <form className={styles.card} onSubmit={submit}>
        <label className={styles.label} htmlFor={fieldId}>
          {label}
        </label>

        {hint ? <p className={styles.hint}>{hint}</p> : null}

        <input
          ref={field}
          id={fieldId}
          className={styles.input}
          value={value}
          autoFocus
          disabled={busy}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel?.();
          }}
        />

        {error ? <p className={styles.error}>{error}</p> : null}

        <div className={styles.actions}>
          {onCancel ? (
            <button type="button" className={styles.cancel} onClick={() => onCancel()}>
              Cancel
            </button>
          ) : null}
          <button type="submit" className={styles.confirm} disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
