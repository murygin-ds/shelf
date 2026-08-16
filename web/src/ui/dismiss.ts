import { useRef, type MouseEvent } from 'react';

/**
 * Closing a dialog by clicking its backdrop, without closing it on a text selection.
 *
 * A `click` fires on the nearest common ancestor of where the button went down and where it
 * came up. So dragging to select the text in a rename box and releasing past the edge of the
 * card lands a click on the overlay, and the dialog disappears mid-edit with the name lost —
 * which is what a `stopPropagation` on the card cannot prevent, because the click never
 * passes through the card at all.
 *
 * Requiring the press to have *started* on the overlay is what separates "clicked the
 * backdrop" from "finished a selection somewhere else".
 */
export function useDismiss(onClose: () => void): {
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onClick: (event: MouseEvent<HTMLElement>) => void;
} {
  const fromBackdrop = useRef(false);

  return {
    onMouseDown: (event) => {
      fromBackdrop.current = event.target === event.currentTarget;
    },
    onClick: (event) => {
      if (fromBackdrop.current && event.target === event.currentTarget) onClose();
    },
  };
}
