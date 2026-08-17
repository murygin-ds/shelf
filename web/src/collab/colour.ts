/**
 * A colour per person, derived from their account id.
 *
 * Derived rather than negotiated: everybody computes the same colour for the same person
 * without a round trip, and two tabs of the same account agree without being told. The
 * golden angle spreads adjacent ids as far apart as the wheel allows, so two people who
 * joined a vault one after the other do not get two shades of the same green.
 */

const GOLDEN_ANGLE = 137.508;

export interface PeerColour {
  /** The caret and the name tag. */
  color: string;
  /** The selection behind the text, which has to stay readable through it. */
  colorLight: string;
}

export function peerColour(userId: number): PeerColour {
  const hue = Math.abs(Math.round(userId * GOLDEN_ANGLE)) % 360;

  return {
    color: `hsl(${hue} 70% 55%)`,
    colorLight: `hsl(${hue} 70% 55% / 0.28)`,
  };
}
