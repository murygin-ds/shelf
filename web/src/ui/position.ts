/** Shared placement for the things that float above the shell: pickers, menus, tooltips. */

export interface Size {
  width: number;
  height: number;
}

const MARGIN = 8;

/** Keeps a popover inside the viewport, whatever the pointer or the anchor asked for. */
export function clampToViewport(x: number, y: number, size: Size): { x: number; y: number } {
  return {
    x: Math.max(MARGIN, Math.min(x, window.innerWidth - size.width - MARGIN)),
    y: Math.max(MARGIN, Math.min(y, window.innerHeight - size.height - MARGIN)),
  };
}

/** Under the anchor when there is room for it, over the anchor when there is not. */
export function below(anchor: DOMRect, size: Size, gap = 6): { x: number; y: number } {
  const under = anchor.bottom + gap;
  const y = under + size.height > window.innerHeight ? anchor.top - size.height - gap : under;

  return clampToViewport(anchor.left, y, size);
}
