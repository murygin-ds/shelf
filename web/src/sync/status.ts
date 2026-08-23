/**
 * What the status line says, derived in one place from the facts rather than assembled in
 * the markup. The rule is that it never claims more than is true: "synced" means the last
 * pull came back and nothing is waiting, and until the first one does the line says so.
 */

import { format, m } from '@/i18n';

export type SyncTone = 'ok' | 'busy' | 'warn';

/** Which of the seven the line is in, as opposed to what it says in the reader's language. */
export type SyncState =
  | 'offline'
  | 'sending'
  | 'saving'
  | 'dirty'
  | 'syncing'
  | 'connecting'
  | 'ok';

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
  state: SyncState;
  /** How many sealed bodies the line is speaking for, so nobody has to read it back out. */
  queued: number;
  label: string;
  /** The long version, for the title attribute. */
  detail: string;
}

export function summarize(facts: SyncFacts): SyncSummary {
  const { offline, syncing, saving, dirty, queued, lastSyncedAt, now } = facts;

  if (offline) {
    return {
      tone: 'warn',
      state: 'offline',
      queued,
      label: queued > 0 ? m.sync.offlineQueued(queued) : m.sync.offline,
      detail: `${m.sync.offlineDetail(queued)} ${since(lastSyncedAt, now)}`,
    };
  }

  // Unsent work outranks a pull: the pull is the client catching up with the server, and
  // this is the server still missing something the reader wrote.
  if (queued > 0) {
    return {
      tone: 'busy',
      state: 'sending',
      queued,
      label: m.sync.sending(queued),
      detail: m.sync.sendingDetail(queued),
    };
  }

  if (saving || dirty) {
    return {
      tone: 'busy',
      state: saving ? 'saving' : 'dirty',
      queued,
      label: m.sync.saving,
      detail: saving ? m.sync.savingDetail : m.sync.dirtyDetail,
    };
  }

  if (syncing) {
    return {
      tone: 'busy',
      state: 'syncing',
      queued,
      label: m.sync.syncing,
      detail: m.sync.syncingDetail,
    };
  }

  if (lastSyncedAt === null) {
    return {
      tone: 'busy',
      state: 'connecting',
      queued,
      label: m.sync.connecting,
      detail: m.sync.connectingDetail,
    };
  }

  return {
    tone: 'ok',
    state: 'ok',
    queued,
    label: m.sync.synced,
    detail: `${m.sync.syncedDetail} ${since(lastSyncedAt, now)}`,
  };
}

function since(lastSyncedAt: number | null, now: number): string {
  return lastSyncedAt === null
    ? m.sync.neverSynced
    : m.sync.lastSynced(format.relative(lastSyncedAt, now));
}
