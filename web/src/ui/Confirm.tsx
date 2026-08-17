import {
  type FormEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';

import { useDismiss } from './dismiss';
import styles from './confirm.module.css';

export interface ConfirmRequest {
  title: string;
  /** What the action actually does, in the terms the reader will judge it by. */
  body: string;
  confirmLabel: string;
  /**
   * A phrase the reader has to type out. Reserved for what cannot be undone — it turns a
   * misplaced click into a no-op, which a second button on its own does not.
   */
  requireText?: string;
}

/**
 * Asks before something irreversible. Everything it asks about takes something away, so
 * the confirming button is destructive by default rather than by flag.
 *
 * Same shape as `useNamePrompt`: `await ask(...)` resolves true or false, and `dialog` is
 * rendered wherever the caller likes.
 */
export function useConfirm(): {
  ask: (request: ConfirmRequest) => Promise<boolean>;
  dialog: ReactElement | null;
} {
  const [pending, setPending] = useState<{
    request: ConfirmRequest;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const ask = useCallback(
    (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) => setPending({ request, resolve })),
    [],
  );

  const close = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };

  const dialog = pending ? (
    <Confirm
      key={pending.request.title}
      request={pending.request}
      onAnswer={close}
    />
  ) : null;

  return { ask, dialog };
}

function Confirm({
  request,
  onAnswer,
}: {
  request: ConfirmRequest;
  onAnswer: (ok: boolean) => void;
}) {
  const [typed, setTyped] = useState('');
  const dismiss = useDismiss(() => onAnswer(false));
  const field = useRef<HTMLInputElement | null>(null);
  const cancel = useRef<HTMLButtonElement | null>(null);
  const fieldId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onAnswer(false);
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onAnswer]);

  // Cancel takes the focus when there is nothing to type, so the keyboard lands on the way
  // out rather than on the destructive button.
  useEffect(() => {
    (field.current ?? cancel.current)?.focus();
  }, []);

  const ready = request.requireText === undefined || typed.trim() === request.requireText;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) onAnswer(true);
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <form className={styles.card} onSubmit={submit} role="alertdialog" aria-label={request.title}>
        <h2 className={styles.title}>{request.title}</h2>
        <p className={styles.body}>{request.body}</p>

        {request.requireText !== undefined ? (
          <>
            <label className={styles.label} htmlFor={fieldId}>
              Type <span className={styles.phrase}>{request.requireText}</span> to confirm
            </label>
            <input
              ref={field}
              id={fieldId}
              className={styles.input}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </>
        ) : null}

        <div className={styles.actions}>
          <button
            ref={cancel}
            type="button"
            className={styles.cancel}
            onClick={() => onAnswer(false)}
          >
            Cancel
          </button>
          <button type="submit" className={styles.destroy} disabled={!ready}>
            {request.confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
