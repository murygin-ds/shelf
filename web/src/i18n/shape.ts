import type { en } from './en';

/**
 * The shape of a dictionary.
 *
 * English is the reference because it is where the strings were extracted from, so it is
 * complete by construction. A translation declares `satisfies Messages['<namespace>']` and
 * the compiler then holds it to the same keys and the same function arities — no runtime
 * lookup, no missing-key branch, nothing for `noUncheckedIndexedAccess` to widen.
 */
export type Messages = typeof en;
