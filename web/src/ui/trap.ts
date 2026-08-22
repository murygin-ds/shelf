import { useEffect, type RefObject } from 'react';

/** What the browser will move focus to with Tab. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps focus inside a dialog while it is open, and hands it back afterwards.
 *
 * Without it a modal is a picture rather than a dialog: the first Tab lands somewhere behind
 * it, and somebody working by keyboard walks the whole page before reaching the control the
 * dialog exists to offer. It matters most where the dialog is asking for consent, which is
 * exactly where somebody may not be using a mouse to give it.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const container = ref.current;
    if (!container) return undefined;

    const previous = document.activeElement as HTMLElement | null;

    const inside = (): HTMLElement[] =>
      [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (element) => element.offsetParent !== null || element === document.activeElement,
      );

    // The first control rather than the container: landing on the dialog itself announces
    // nothing, and the first thing here is what somebody has to decide about.
    (inside()[0] ?? container).focus();

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;

      const focusable = inside();
      if (focusable.length === 0) return;

      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      const active = document.activeElement;

      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey, true);

    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [ref]);
}
