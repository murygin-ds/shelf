/**
 * Messages with a node in the middle of them.
 *
 * A handful of sentences wrap part of themselves in markup — a vault name in bold, the
 * phrase a destructive dialog asks to be typed back. Splitting those into a prefix and a
 * suffix around a `{slot}` works in English and breaks in Russian, where the same node
 * lands in a different place in the sentence. Returning an element instead lets the
 * translation own the whole order, and a forgotten slot becomes a compile error.
 *
 * These live apart from the plain namespaces on purpose: a `.ts` dictionary must stay free
 * of React, or the jsx runtime follows `m` into `sync/status.ts` and the store.
 */

import type { ReactElement, ReactNode } from 'react';

export const uiRich = {
  typeToConfirm: (phrase: ReactNode): ReactElement => <>Type {phrase} to confirm</>,
};
