import { describe, expect, it } from 'vitest';

import { peerColour } from './colour';

describe('peer colours', () => {
  // Everybody has to compute the same colour for the same person, without asking anybody.
  it('gives one person the same colour everywhere', () => {
    expect(peerColour(42)).toEqual(peerColour(42));
  });

  // Two people who joined a vault one after the other should not get two shades of the
  // same green, which is the whole reason for the golden angle.
  it('keeps neighbouring accounts apart', () => {
    const hue = (userId: number): number => {
      const match = /hsl\((\d+)/.exec(peerColour(userId).color);

      return Number(match?.[1] ?? 0);
    };

    for (let id = 1; id < 30; id++) {
      const distance = Math.abs(hue(id) - hue(id + 1));

      expect(Math.min(distance, 360 - distance)).toBeGreaterThan(30);
    }
  });

  it('stays inside the wheel for any account id', () => {
    for (const id of [0, 1, 7, 1000, 2 ** 31]) {
      const match = /hsl\((\d+)/.exec(peerColour(id).color);

      expect(Number(match?.[1])).toBeGreaterThanOrEqual(0);
      expect(Number(match?.[1])).toBeLessThan(360);
    }
  });
});
