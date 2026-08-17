import { describe, expect, it } from 'vitest';

import { summarize, type SyncFacts } from './status';

/**
 * The status line used to say SYNCED whenever nothing had gone wrong yet, which is not the
 * same thing at all: a tab that has never reached the server and a tab holding writes it
 * could not send both read as "synced". These pin the cases where the line has to say less
 * than that.
 */

const MINUTE = 60_000;

function facts(patch: Partial<SyncFacts> = {}): SyncFacts {
  return {
    offline: false,
    syncing: false,
    saving: false,
    dirty: false,
    queued: 0,
    lastSyncedAt: 1_000_000,
    now: 1_000_000,
    ...patch,
  };
}

describe('the sync status', () => {
  it('does not claim to be synced before the first pull comes back', () => {
    expect(summarize(facts({ lastSyncedAt: null }))).toMatchObject({
      tone: 'busy',
      label: 'CONNECTING',
    });
  });

  it('says synced only when the server has everything', () => {
    const summary = summarize(facts({ now: 1_000_000 + 5 * MINUTE }));

    expect(summary.tone).toBe('ok');
    expect(summary.label).toBe('SYNCED');
    expect(summary.detail).toContain('5 min ago');
  });

  it('counts what is waiting when there is no connection', () => {
    expect(summarize(facts({ offline: true, queued: 2 }))).toMatchObject({
      tone: 'warn',
      label: 'OFFLINE · 2 QUEUED',
    });
  });

  it('promises the writes are kept when there is nothing queued yet', () => {
    const summary = summarize(facts({ offline: true }));

    expect(summary.label).toBe('OFFLINE');
    expect(summary.detail).toContain('kept here');
  });

  // The pull is the client catching up with the server; a queued body is the server still
  // missing something the reader wrote, and that is the one worth reporting.
  it('reports unsent work ahead of a pull in flight', () => {
    expect(summarize(facts({ syncing: true, queued: 1 }))).toMatchObject({ label: 'SENDING 1' });
  });

  it('does not call keystrokes the autosave has not taken yet synced', () => {
    expect(summarize(facts({ dirty: true }))).toMatchObject({ tone: 'busy', label: 'SAVING' });
  });
});
