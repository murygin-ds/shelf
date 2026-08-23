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

/**
 * How many names the picture can carry at this scale.
 *
 * Labels are the first thing to collide — two adjacent dots are enough — so they arrive as
 * the reader comes closer rather than being drawn and hoped for. The tiers are an attribute
 * on the canvas; which text they actually hide is a stylesheet's business.
 */
export function labelTier(k: number): 'off' | 'hubs' | 'all' {
  if (k < 0.45) return 'off';
  if (k < 0.85) return 'hubs';

  return 'all';
}

/** Rounded, because this string is rewritten on every animation frame. */
export function transform(view: View): string {
  const round = (value: number) => Math.round(value * 100) / 100;

  return `translate(${round(view.x)},${round(view.y)}) scale(${round(view.k)})`;
}
