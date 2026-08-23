/**
 * Sentences with a node in them, for search, the graph, the trash and the account.
 *
 * Empty on purpose. The one place these views wrap part of a sentence in markup is the
 * account-deletion dialog, which asks for the login to be typed back — the same sentence
 * `ui/Confirm.tsx` asks with, and `uiRich.typeToConfirm` already owns its word order in
 * both languages. A second copy here would be a second thing to keep in step.
 */

export const viewsRich = {};
