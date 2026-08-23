import { describe, expect, it } from 'vitest';

import { summarize, type SyncFacts } from './status';

/**
 * The status line used to say SYNCED whenever nothing had gone wrong yet, which is not the
 * same thing at all: a tab that has never reached the server and a tab holding writes it
 * could not send both read as "synced". These pin the cases where the line has to say less
 * than that.
 *
 * They match on `state` and `queued` rather than on the words. The words are copy — they
 * are written in whichever language the reader picked, and asserting them tests the
 * dictionary instead of the rule. One case still reads the label, to prove the count
 * reaches it at all.
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
      state: 'connecting',
    });
  });

  it('says synced only when the server has everything', () => {
    expect(summarize(facts({ now: 1_000_000 + 5 * MINUTE }))).toMatchObject({
      tone: 'ok',
      state: 'ok',
      queued: 0,
    });
  });

  it('counts what is waiting when there is no connection', () => {
    expect(summarize(facts({ offline: true, queued: 2 }))).toMatchObject({
      tone: 'warn',
      state: 'offline',
      queued: 2,
    });
  });

  it('is still offline, not sending, when nothing is queued yet', () => {
    expect(summarize(facts({ offline: true }))).toMatchObject({
      tone: 'warn',
      state: 'offline',
      queued: 0,
    });
  });

  // The pull is the client catching up with the server; a queued body is the server still
  // missing something the reader wrote, and that is the one worth reporting.
  it('reports unsent work ahead of a pull in flight', () => {
    expect(summarize(facts({ syncing: true, queued: 1 }))).toMatchObject({ state: 'sending' });
  });

  it('does not call keystrokes the autosave has not taken yet synced', () => {
    expect(summarize(facts({ dirty: true }))).toMatchObject({ tone: 'busy', state: 'dirty' });
  });

  // The one case that touches the copy: whatever the words are, the queue reaches them.
  it('puts the queue count into the line the reader sees', () => {
    const summary = summarize(facts({ offline: true, queued: 3 }));

    expect(summary.label).not.toBe('');
    expect(summary.label).toContain('3');
    expect(summary.detail).toContain('3');
  });
});
