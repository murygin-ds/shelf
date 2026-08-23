/**
 * What a failure says to the reader.
 *
 * The server's own `message` never reaches this file or the screen. It is written for a
 * log and for whoever is holding the stack trace, it is English by design, and translating
 * it would mean translating it on the server — where the request has no reader attached to
 * it. What crosses the wire instead is a machine reason in `details.reason`; the sentence
 * is written here.
 *
 * Three tables, tried in order: the reason, then the code, then the status. A reason this
 * client has never heard of falls through to the code, which is why these are open records
 * rather than exhaustive ones.
 */

import { countedEn } from '../plural';

export const errors = {
  /**
   * Keyed by internal/api/response.Reason*. This is where a sentence that used to be written
   * at one call site belongs — «you are already a member» was a status 409 in the join
   * screen, and a 409 anywhere else means something entirely different.
   *
   * Each one has to stand alone: it is shown in a banner or under a form with nothing beside
   * it, so it names what happened rather than restating the code. A handful describe refusals
   * only a broken client can provoke — a route that does not exist, an If-Match the server
   * could not read — and those say the true short thing instead of inventing a reader.
   */
  byReason: {
    route_not_found: 'There is no such address on this server.',
    method_not_allowed: 'That address does not take this kind of request.',
    body_too_large: 'That is larger than the server takes in one request.',
    query_invalid: 'The server could not read one of the request parameters.',
    if_match_required: 'The write did not say which version it was based on.',
    if_match_invalid: 'The version this write named is not one the server can read.',
    rate_limited: 'Too many requests in a row. The server will take them again in a few minutes.',
    internal:
      'The server ran into a problem of its own. Nothing you sent caused it — try again in a moment.',
    database_unavailable:
      'The server cannot reach its database right now. Nothing has been lost; try again in a moment.',

    auth_header_missing: 'The request went out without a sign-in token. Sign in again.',
    token_invalid: 'This sign-in is no longer valid. Sign in again.',
    unauthenticated: 'You are signed out. Sign in again.',

    login_blank: 'A login cannot be empty.',
    login_taken: 'That address is already registered.',
    invalid_credentials: 'Wrong login or passphrase.',
    password_invalid: 'That passphrase does not match the one on this account.',
    display_name_blank: 'A display name cannot be empty.',
    refresh_token_invalid: 'Your session has expired. Sign in again.',
    // Deliberately not the sentence above it: a replayed token is what a stolen one looks
    // like, the server has already signed the account out everywhere, and the reader has to
    // be told that rather than left thinking one tab timed out.
    refresh_token_reused:
      'A sign-in token was presented twice, which is how a stolen one behaves. Every session on this account has been signed out. Sign in again.',
    recovery_code_invalid: 'Wrong login or recovery code.',
    recovery_token_invalid:
      'This recovery is no longer open. Start it again with your login and recovery code.',
    session_id_invalid: 'The server could not read which session that was.',
    session_not_found: 'That device is already signed out.',

    // Both a resource that is gone and an invite that will not open answer with this one, so
    // that looking an invite up cannot become a probe for valid codes. The sentence has to be
    // true of both.
    not_found:
      'This is gone: either it was deleted, or the code or link pointing at it no longer works.',
    forbidden: 'Your access here does not go that far.',
    version_conflict: 'Somebody saved this note before you. Reload the page to see their version.',
    scope_mismatch:
      'This was sealed under a different key than the place it is going to. Reload the page — the keys may have been rotated since this tab read them.',
    folder_cycle: 'A folder cannot be moved inside itself.',
    depth_exceeded: 'Folders cannot be nested any deeper than this.',
    share_expiry: 'A public link has to expire at some point in the future.',
    link_batch: 'A note can point at 500 others at most.',
    signature_invalid: 'The signature on that write was not accepted.',
    rekey_stale: 'This key rotation is no longer open. Start it again.',
    key_grant_missing: 'A new key has to be sealed to at least one member, or nobody can open it.',
    rekey_batch: 'A rotation sends between 1 and 200 rows at a time.',
    epoch_mismatch: 'A newer editing session has replaced this one. Reload the page to join it.',
    compact_required: 'The editing session has to be saved before it can take more changes.',
    update_too_large:
      'This editing session has grown past what the server keeps. Reload the page to start a fresh one.',
    label_incomplete: 'A name has to arrive with both its ciphertext and its nonce.',

    owner_required:
      'Only the owner of the vault can do that, and the owner cannot be removed from it.',
    self_target: 'You cannot apply this to yourself.',
    already_member: 'You are already a member of this vault.',
    keys_required:
      'This change needs the vault keys sealed to that member, and they did not arrive with it.',
    group_members: 'A group holds between 1 and 200 members.',
    group_keyless: 'Only a member of a group can change who is in it.',
    group_scopes: 'Rotating a group has to re-seal every key scope the group holds.',
    group_rotation:
      'Removing somebody from a group needs a new group key, with its scopes sealed again.',
    invite_path: 'An invite names either a code or a person, not both.',
    redeem_path: 'An invite is redeemed by its code or by its id, not both.',

    connector_role_invalid: 'A connector can be an Editor or a Viewer, and nothing else.',
    connector_exists: 'This vault already has a connector.',

    // Not from the server: these are the faults `lib/archive.ts` and `lib/zip.ts` name when
    // a file dropped on the import modal turns out not to be an archive. They share the
    // table because they answer the same question — why did that not work — and because the
    // two vocabularies cannot collide: the server writes snake_case, these are kebab-case.
    'no-manifest': 'This is not a Shelf archive: it carries no manifest.',
    'unreadable': 'The manifest in this archive cannot be read.',
    'not-shelf': 'This is not a Shelf archive.',
    'too-new': 'This archive was written by a newer version of Shelf. Update, then import it again.',
    'incomplete': 'The manifest in this archive is incomplete, so there is no telling what is inside.',
    'not-a-zip': 'This file is not a zip archive.',
    'zip64': 'This archive is in the Zip64 format, which Shelf does not read.',
    'directory-damaged': 'The index of this archive is damaged.',
    'entry-misplaced': 'A file inside this archive is not where the index says it is.',
    'entry-truncated': 'A file inside this archive breaks off part way.',
    'method-unsupported': 'A file inside this archive is packed in a way Shelf does not read.',
    'entry-corrupt': 'A file inside this archive did not survive: its checksum does not match.',
  } as Record<string, string>,

  byCode: {
    bad_request: 'The server did not understand that request.',
    validation_error: 'The server rejected that as invalid.',
    unauthorized: 'You are signed out. Sign in again.',
    forbidden: 'You are not allowed to do that.',
    not_found: 'That is gone.',
    conflict: 'Somebody changed this first.',
    payload_too_large: 'That is too large to send.',
    too_many_requests: 'Too many attempts. Try again in a moment.',
    internal_error: 'The server ran into a problem.',
  } as Record<string, string>,

  /** The last rung: a code this build has never heard of still has a status behind it. */
  byStatus: {
    400: 'The server refused that request.',
    401: 'You are signed out. Sign in again.',
    403: 'You are not allowed to do that.',
    404: 'That is gone.',
    409: 'Somebody changed this first.',
    413: 'That is too large to send.',
    429: 'Too many attempts. Try again in a moment.',
  } as Record<number, string>,

  /** When the server said how long to wait, saying it back is worth more than «in a moment». */
  retryIn: (minutes: number) =>
    `Too many attempts. Try again in ${countedEn(minutes, ['minute', 'minutes'])}.`,

  offline: 'No connection to the server.',
  badPassphrase: 'Your keys would not open with that passphrase.',
  unknown: 'Something went wrong.',
};
