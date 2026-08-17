/**
 * What the status line says, derived in one place from the facts rather than assembled in
 * the markup. The rule is that it never claims more than is true: "synced" means the last
 * pull came back and nothing is waiting, and until the first one does the line says so.
 */

export type SyncTone = 'ok' | 'busy' | 'warn';

export interface SyncFacts {
  /** The server could not be reached the last time anything tried. */
  offline: boolean;
  /** A pull is in flight. */
  syncing: boolean;
  /** A body is being sealed and sent. */
  saving: boolean;
  /** The open note has keystrokes the autosave has not taken yet. */
  dirty: boolean;
  /** Bodies sealed on this device and waiting for a network. */
  queued: number;
  /** When the last pull came back, or null before the first one does. */
  lastSyncedAt: number | null;
  now: number;
}

export interface SyncSummary {
  tone: SyncTone;
  label: string;
  /** The long version, for the title attribute. */
  detail: string;
}

export function summarize(facts: SyncFacts): SyncSummary {
  const { offline, syncing, saving, dirty, queued, lastSyncedAt, now } = facts;

  if (offline) {
    const kept =
      queued > 0
        ? `${queued} ${queued === 1 ? 'change is' : 'changes are'} sealed on this device and will be sent when the connection comes back.`
        : 'Everything already on this device stays readable, and anything you write is kept here until the connection comes back.';

    return {
      tone: 'warn',
      label: queued > 0 ? `OFFLINE · ${queued} QUEUED` : 'OFFLINE',
      detail: `No connection to the server. ${kept}${since(lastSyncedAt, now)}`,
    };
  }

  // Unsent work outranks a pull: the pull is the client catching up with the server, and
  // this is the server still missing something the reader wrote.
  if (queued > 0) {
    return {
      tone: 'busy',
      label: `SENDING ${queued}`,
      detail: `Sending ${queued} ${queued === 1 ? 'change' : 'changes'} written while the connection was gone.`,
    };
  }

  if (saving || dirty) {
    return {
      tone: 'busy',
      label: 'SAVING',
      detail: saving
        ? 'Encrypting this note and sending it.'
        : 'Unsaved keystrokes. They are encrypted and sent a moment after you stop typing.',
    };
  }

  if (syncing) {
    return { tone: 'busy', label: 'SYNCING', detail: 'Reading changes from the server.' };
  }

  if (lastSyncedAt === null) {
    return { tone: 'busy', label: 'CONNECTING', detail: 'Has not reached the server yet.' };
  }

  return {
    tone: 'ok',
    label: 'SYNCED',
    detail: `Everything on this device is on the server.${since(lastSyncedAt, now)}`,
  };
}

function since(lastSyncedAt: number | null, now: number): string {
  if (lastSyncedAt === null) return ' Nothing has been read from the server yet.';

  return ` Last synced ${ago(Math.max(0, now - lastSyncedAt))}.`;
}

function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;

  return `${Math.floor(hours / 24)} d ago`;
}
