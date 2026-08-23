/**
 * A failure, as a sentence the reader can act on.
 *
 * This is the only way an error reaches the screen. Before it there were nine copies of the
 * same function with fallbacks that had quietly drifted apart — «something went wrong»,
 * «Something went wrong.», «the graph could not be drawn» — and two switch statements in the
 * stores doing the same job again.
 *
 * `cause.message` is never shown. It is written by the server for a log and for whoever is
 * holding the stack trace: English by design, phrased for a developer, and often naming
 * internals. What the server sends for the reader is a machine cause in `details.reason`,
 * and the sentence for it is written in the dictionary. Adding `?? cause.message` here to
 * make a rare case «more informative» puts untranslated server internals in front of the
 * user for every case.
 */

import { m } from '@/i18n';

import { ApiError, OfflineError } from './client';

export function describe(cause: unknown): string {
  if (cause instanceof OfflineError) return m.errors.offline;

  // WebCrypto's way of saying the wrapped key did not open, which for a passphrase the
  // server accepted means the passphrase is wrong.
  if (cause instanceof DOMException) return m.errors.badPassphrase;

  if (cause instanceof ApiError) return fromApi(cause);

  // An error from this app that names its own cause. Read structurally rather than by
  // class so that `api/` does not have to import `lib/` to know about an archive: any
  // error carrying a machine-readable `reason` gets the sentence written for it, and one
  // that carries nothing still falls through to the generic line.
  const said = pick(m.errors.byReason, localReason(cause));
  if (said !== undefined) return said;

  return m.errors.unknown;
}

function localReason(cause: unknown): string | undefined {
  if (!(cause instanceof Error)) return undefined;

  const reason: unknown = (cause as { reason?: unknown }).reason;

  return typeof reason === 'string' ? reason : undefined;
}

function fromApi(cause: ApiError): string {
  // Ahead of the tables rather than after them: «try again in three minutes» is worth more
  // than «try again in a moment», and only the response carries the number.
  if (cause.status === 429 && cause.retryAfter) {
    return m.errors.retryIn(Math.ceil(cause.retryAfter / 60));
  }

  return (
    pick(m.errors.byReason, cause.reason) ??
    pick(m.errors.byCode, cause.code) ??
    m.errors.byStatus[cause.status] ??
    m.errors.unknown
  );
}

function pick(table: Record<string, string>, key: string | undefined): string | undefined {
  return key === undefined ? undefined : table[key];
}
