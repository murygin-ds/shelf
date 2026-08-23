/**
 * The status line at the bottom right: the short word, and the long version behind it.
 *
 * Every branch writes its whole sentence. The line reads as one thought — the state, what
 * is being kept, and when the server was last heard from — and Russian will not let those
 * be glued together out of English-shaped parts.
 */

import { countedEn } from '../plural';

export const sync = {
  offline: 'Offline',
  offlineQueued: (queued: number) => `Offline · ${queued} queued`,
  sending: (queued: number) => `Sending ${queued}`,
  saving: 'Saving',
  syncing: 'Syncing',
  connecting: 'Connecting',
  synced: 'Synced',

  offlineDetail: (queued: number) =>
    queued > 0
      ? `No connection to the server. ${countedEn(queued, ['change is', 'changes are'])} sealed on this device and will be sent when the connection comes back.`
      : 'No connection to the server. Everything already on this device stays readable, and anything you write is kept here until the connection comes back.',

  sendingDetail: (queued: number) =>
    `Sending ${countedEn(queued, ['change', 'changes'])} written while the connection was gone.`,

  savingDetail: 'Encrypting this note and sending it.',
  dirtyDetail: 'Unsaved keystrokes. They are encrypted and sent a moment after you stop typing.',
  syncingDetail: 'Reading changes from the server.',
  connectingDetail: 'Has not reached the server yet.',
  syncedDetail: 'Everything on this device is on the server.',

  lastSynced: (when: string) => `Last synced ${when}.`,
  neverSynced: 'Nothing has been read from the server yet.',
};
