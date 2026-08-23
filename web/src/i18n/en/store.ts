/**
 * What the stores say when nothing on screen is in a position to say it.
 *
 * These land in `error` on the workspace store, which the shell renders as a banner, or come
 * back out of a rejected action for the button that started it. Either way there is no
 * surrounding sentence to lean on, so each one names the note or the vault it is about.
 *
 * The refusals the stores throw for their own sake — «no active vault», «open the vault
 * first» where nothing renders the message — stay English where they are written. They are
 * diagnostics: `describe` turns them into `errors.unknown` long before a reader sees them.
 */

export const store = {
  openVaultFirst: 'Open a vault first.',
  readOnly: 'Read-only mode is on for this browser.',
  nameRequired: 'Give it a name first.',
  nameTaken: (name: string) => `There is already something called “${name}” here.`,
  areaNameTaken: (area: string, name: string) => `${area} already holds a “${name}”.`,

  /** The tree comes from the cache, so a note can be listed here with its body still away. */
  bodyNotHere: (name: string) =>
    `“${name}” is not on this device yet, and there is no connection to fetch it.`,

  unverifiedEdit: 'An edit arrived that could not be verified, and it was not applied.',

  offlineGone: 'A note written offline could not be restored: it no longer exists.',
  offlineKeyless: 'A note written offline could not be restored: its key is gone.',
  offlineKept: (name: string) =>
    `“${name}” changed while you were offline; your version was kept as a copy.`,

  changeNotSaved:
    'No connection. That change was not saved — try it again once you are back online.',

  /**
   * Content, not interface: these become part of a note's name, are typed into the tree, and
   * travel out through export. They are translated for the same reason the note is written in
   * the reader's language — and they are the one thing here a change of language will not
   * revisit, because by then they are somebody's data.
   */
  copyName: {
    mine: (name: string) => `${name} (my version)`,
    offline: (name: string) => `${name} (offline copy)`,
  },
};
