import { describe, expect, it } from 'vitest';

import {
  clampScale,
  fit,
  FIT_MAX_K,
  IDENTITY,
  LABEL_MIN_K,
  MAX_K,
  MIN_K,
  pan,
  placeLabels,
  recentre,
  toScreen,
  toWorld,
  transform,
  zoomAt,
  type View,
} from './viewport';

const VIEW: View = { x: 40, y: -15, k: 0.7 };

describe('zoomAt', () => {
  it('leaves whatever is under the pointer under the pointer', () => {
    const at = { x: 320, y: 180 };
    const before = toWorld(VIEW, at);
    const after = toWorld(zoomAt(VIEW, at, 1.6), at);

    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('stops at the limits instead of running away', () => {
    expect(zoomAt(VIEW, { x: 0, y: 0 }, 1e6).k).toBe(MAX_K);
    expect(zoomAt(VIEW, { x: 0, y: 0 }, 1e-6).k).toBe(MIN_K);
  });

  it('returns the same view when there is no room left to zoom', () => {
    const stuck: View = { x: 0, y: 0, k: MAX_K };

    expect(zoomAt(stuck, { x: 10, y: 10 }, 2)).toBe(stuck);
  });
});

describe('clampScale', () => {
  it('answers something usable for a scale that is not a number', () => {
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe('pan and toWorld', () => {
  it('moves the picture by the distance the hand moved', () => {
    expect(pan(VIEW, 12, -8)).toEqual({ x: 52, y: -23, k: 0.7 });
  });

  it('undoes itself', () => {
    const at = { x: 210, y: 90 };
    const back = toScreen(VIEW, toWorld(VIEW, at));

    expect(back.x).toBeCloseTo(at.x, 9);
    expect(back.y).toBeCloseTo(at.y, 9);
  });
});

describe('fit', () => {
  const size = { width: 800, height: 400 };

  it('centres the graph in the panel', () => {
    const box = { minX: -100, minY: -50, maxX: 300, maxY: 150 };
    const view = fit(box, size, 40);
    const centre = toScreen(view, { x: 100, y: 50 });

    expect(centre.x).toBeCloseTo(400, 9);
    expect(centre.y).toBeCloseTo(200, 9);
  });

  it('shrinks a graph wider than the panel until it is inside it', () => {
    const box = { minX: -2000, minY: -1000, maxX: 2000, maxY: 1000 };
    const view = fit(box, size, 40);

    expect(toScreen(view, { x: box.minX, y: box.minY }).x).toBeGreaterThanOrEqual(40);
    expect(toScreen(view, { x: box.maxX, y: box.maxY }).x).toBeLessThanOrEqual(size.width - 40);
  });

  it('does not blow three notes up into three balloons', () => {
    expect(fit({ minX: -8, minY: -8, maxX: 8, maxY: 8 }, size, 40).k).toBe(FIT_MAX_K);
  });

  it('is the identity while there is nothing to fit or nowhere to fit it', () => {
    expect(fit(null, size, 40)).toEqual(IDENTITY);
    expect(fit({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, { width: 0, height: 0 }, 40)).toEqual(
      IDENTITY,
    );
  });
});

describe('recentre', () => {
  it('keeps the middle of the panel showing what it was showing', () => {
    const from = { width: 800, height: 400 };
    const to = { width: 600, height: 500 };
    const middle = toWorld(VIEW, { x: from.width / 2, y: from.height / 2 });
    const after = toWorld(recentre(VIEW, from, to), { x: to.width / 2, y: to.height / 2 });

    expect(after.x).toBeCloseTo(middle.x, 9);
    expect(after.y).toBeCloseTo(middle.y, 9);
  });
});

describe('placeLabels', () => {
  const SIZE = { width: 800, height: 600 };
  const AT_ONE: View = { x: 400, y: 300, k: 1 };
  const tag = (x: number, y: number, rank: number) => ({ x, y, radius: 5, chars: 10, rank });

  it('gives a name to a note with room around it', () => {
    expect(placeLabels([tag(0, 0, 1), tag(200, 0, 1)], AT_ONE, SIZE)).toEqual([true, true]);
  });

  it('lets the busier of two crowded notes keep its name', () => {
    expect(placeLabels([tag(0, 0, 1), tag(8, 4, 5)], AT_ONE, SIZE)).toEqual([false, true]);
  });

  it('does not write a name across a neighbouring dot', () => {
    // The second dot sits right under the first one's label.
    expect(placeLabels([tag(0, 0, 5), tag(0, 16, 1)], AT_ONE, SIZE)[0]).toBe(false);
  });

  it('gives back the names crowding took away once the reader zooms in', () => {
    const tags = [tag(0, 0, 1), tag(30, 0, 5)];
    const close: View = { x: 400, y: 300, k: 3 };

    expect(placeLabels(tags, AT_ONE, SIZE)).toEqual([false, true]);
    expect(placeLabels(tags, close, SIZE)).toEqual([true, true]);
  });

  it('draws none from far enough away', () => {
    const far: View = { x: 400, y: 300, k: LABEL_MIN_K / 2 };

    expect(placeLabels([tag(0, 0, 1)], far, SIZE)).toEqual([false]);
  });

  it('lets a note faded out of focus neither take a name nor block one', () => {
    const quiet = { ...tag(0, 16, 9), quiet: true };

    expect(placeLabels([tag(0, 0, 1), quiet], AT_ONE, SIZE)).toEqual([true, false]);
  });

  it('skips names that would land off screen', () => {
    expect(placeLabels([tag(2000, 0, 1)], AT_ONE, SIZE)).toEqual([false]);
  });
});

describe('transform', () => {
  it('is rounded, being rewritten every frame', () => {
    expect(transform({ x: 12.34567, y: -8.7654, k: 0.98765 })).toBe(
      'translate(12.35,-8.77) scale(0.99)',
    );
  });
});
