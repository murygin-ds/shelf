import { describe, expect, it } from 'vitest';

import { isOnline, markReachable, markUnreachable, subscribe } from './connectivity';

/**
 * The workspace used to learn it was offline only from a request that failed, and the poller
 * skipped the request whenever the browser said there was no network — so nothing ever
 * failed and the status line kept saying SYNCED with the cable out. What replaced it has to
 * announce the change, and has to announce it once.
 */

describe('the connectivity watch', () => {
  it('tells its watchers when the server stops answering, and when it starts again', () => {
    const seen: boolean[] = [];
    const unwatch = subscribe((online) => seen.push(online));

    markUnreachable();
    markReachable();

    expect(seen).toEqual([false, true]);
    expect(isOnline()).toBe(true);

    unwatch();
  });

  // Every request reports its outcome, so a working connection calls this several times a
  // second. Waking the outbox on each of them would be a flush per request.
  it('says nothing when the answer has not changed', () => {
    const seen: boolean[] = [];
    const unwatch = subscribe((online) => seen.push(online));

    markReachable();
    markReachable();
    markUnreachable();
    markUnreachable();

    expect(seen).toEqual([false]);

    unwatch();
    markReachable();
  });

  it('stops telling a watcher that has gone away', () => {
    const seen: boolean[] = [];
    subscribe((online) => seen.push(online))();

    markUnreachable();
    markReachable();

    expect(seen).toEqual([]);
  });
});
