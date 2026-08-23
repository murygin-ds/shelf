/**
 * Words that belong to no single screen.
 *
 * Deliberately short: a word only earns a place here when three or more areas would spell
 * it identically. Russian pulls neighbouring phrases apart by case far more often than
 * English does, so a shared entry that has to be bent at one call site was never shared.
 */

export const common = {
  cancel: 'Cancel',
  close: 'Close',
  done: 'Done',
  ok: 'OK',
  save: 'Save',
  saved: 'Saved',
  delete: 'Delete',
  remove: 'Remove',
  rename: 'Rename',
  open: 'Open',
  copy: 'Copy',
  copied: 'Copied',
  retry: 'Try again',
  back: 'Back',
  loading: 'Loading…',
  justNow: 'just now',
  never: 'never',
  unknown: 'unknown',
};
