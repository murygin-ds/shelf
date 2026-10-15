import type { Box } from './layout';

/**
 * What part of the world is on screen.
 *
 * `screen = world * k + (x, y)`, which is the whole model: the graph is laid out once in
 * absolute coordinates and this is the only thing between it and the pixels. Written by
 * hand rather than with `d3-zoom`, which would bring `d3-selection`, `d3-drag`,
 * `d3-transition` and `d3-interpolate` along for about seventy lines of arithmetic — and
 * arithmetic is exactly the part worth having as a tested pure function.
 */

export interface View {
  x: number;
  y: number;
  k: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const MIN_K = 0.08;
export const MAX_K = 4;

/** Fitting never magnifies past this: three notes should not arrive as three balloons. */
export const FIT_MAX_K = 1.2;

export const IDENTITY: View = { x: 0, y: 0, k: 1 };

export function clampScale(k: number): number {
  if (!Number.isFinite(k)) return 1;

  return Math.min(Math.max(k, MIN_K), MAX_K);
}

/**
 * Zoom about a point on screen, leaving whatever is under it under it.
 *
 * That fixed point is the difference between a zoom that feels like a magnifier and one that
 * feels like the picture jumping: without it the reader chases the node they were looking at
 * across the canvas.
 */
export function zoomAt(view: View, at: Point, factor: number): View {
  const k = clampScale(view.k * factor);
  if (k === view.k) return view;

  const ratio = k / view.k;

  return { k, x: at.x - (at.x - view.x) * ratio, y: at.y - (at.y - view.y) * ratio };
}

export function pan(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

export function toWorld(view: View, at: Point): Point {
  return { x: (at.x - view.x) / view.k, y: (at.y - view.y) / view.k };
}

export function toScreen(view: View, at: Point): Point {
  return { x: at.x * view.k + view.x, y: at.y * view.k + view.y };
}

/** The view that shows the whole box, centred, with room to breathe around it. */
export function fit(box: Box | null, size: Size, padding: number): View {
  if (!box || size.width <= 0 || size.height <= 0) return IDENTITY;

  const width = Math.max(box.maxX - box.minX, 1);
  const height = Math.max(box.maxY - box.minY, 1);
  const room = {
    width: Math.max(size.width - padding * 2, 1),
    height: Math.max(size.height - padding * 2, 1),
  };

  const k = clampScale(Math.min(room.width / width, room.height / height, FIT_MAX_K));

  return {
    k,
    x: size.width / 2 - ((box.minX + box.maxX) / 2) * k,
    y: size.height / 2 - ((box.minY + box.maxY) / 2) * k,
  };
}

/** Keeps whatever is in the middle of the panel in the middle when the panel resizes. */
export function recentre(view: View, from: Size, to: Size): View {
  return pan(view, (to.width - from.width) / 2, (to.height - from.height) / 2);
}

/** A name to place under its dot: world position and radius, length and how much it matters. */
export interface Tag {
  x: number;
  y: number;
  radius: number;
  chars: number;
  rank: number;
  /** Faded out of focus: neither named nor in the way of a name, being barely drawn. */
  quiet?: boolean;
}

/** Below this scale the picture is a shape, not a map, and no name is drawn at all. */
export const LABEL_MIN_K = 0.2;

/** On-screen metrics of a label: the stylesheet counter-scales it to this size at any zoom. */
export const LABEL_FONT_PX = 9.5;
const CHAR_PX = LABEL_FONT_PX * 0.6;
const LINE_PX = 12;
const GAP_PX = 3;
const CELL_PX = 64;

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
  owner: number;
}

/**
 * Which names fit on screen without touching another name or somebody else's dot.
 *
 * Greedy and in rank order, so the busiest notes keep their names and the rest arrive as the
 * reader zooms in and the dots move apart. Done in screen space because labels are a constant
 * size on screen; a fixed rule by degree or zoom either leaves a dense corner illegible or
 * hides names that would have fit.
 */
export function placeLabels(tags: Tag[], view: View, size: Size): boolean[] {
  const shown = new Array<boolean>(tags.length).fill(false);
  if (view.k < LABEL_MIN_K || size.width <= 0 || size.height <= 0) return shown;

  const grid = new Map<number, Rect[]>();
  const cells = (rect: Rect, visit: (key: number) => boolean | void): boolean => {
    const x0 = Math.floor(rect.left / CELL_PX);
    const x1 = Math.floor(rect.right / CELL_PX);
    const y0 = Math.floor(rect.top / CELL_PX);
    const y1 = Math.floor(rect.bottom / CELL_PX);

    for (let cx = x0; cx <= x1; cx += 1) {
      for (let cy = y0; cy <= y1; cy += 1) {
        if (visit(cx * 100003 + cy)) return true;
      }
    }

    return false;
  };
  const insert = (rect: Rect) =>
    cells(rect, (key) => {
      const bucket = grid.get(key);
      if (bucket) bucket.push(rect);
      else grid.set(key, [rect]);
    });
  const blocked = (rect: Rect) =>
    cells(rect, (key) =>
      (grid.get(key) ?? []).some(
        (other) =>
          other.owner !== rect.owner &&
          other.left < rect.right &&
          rect.left < other.right &&
          other.top < rect.bottom &&
          rect.top < other.bottom,
      ),
    );

  const centres = tags.map((tag) => toScreen(view, tag));

  tags.forEach((tag, index) => {
    const at = centres[index];
    if (!at || tag.quiet) return;

    const r = tag.radius * view.k;
    insert({ left: at.x - r, top: at.y - r, right: at.x + r, bottom: at.y + r, owner: index });
  });

  const order = tags.map((_, index) => index).sort((a, b) => (tags[b]?.rank ?? 0) - (tags[a]?.rank ?? 0));

  for (const index of order) {
    const tag = tags[index];
    const at = centres[index];
    if (!tag || !at || tag.quiet) continue;

    const half = (tag.chars * CHAR_PX) / 2 + 2;
    const top = at.y + tag.radius * view.k + GAP_PX;
    const rect = { left: at.x - half, top, right: at.x + half, bottom: top + LINE_PX, owner: index };

    if (rect.right < 0 || rect.left > size.width || rect.bottom < 0 || rect.top > size.height) {
      continue;
    }

    if (blocked(rect)) continue;

    insert(rect);
    shown[index] = true;
  }

  return shown;
}

/** Rounded, because this string is rewritten on every animation frame. */
export function transform(view: View): string {
  const round = (value: number) => Math.round(value * 100) / 100;

  return `translate(${round(view.x)},${round(view.y)}) scale(${round(view.k)})`;
}
