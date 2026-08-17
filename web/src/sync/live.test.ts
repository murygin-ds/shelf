import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { connect, type LiveHandlers } from './live';

/** A socket the test drives by hand. Only the parts live.ts touches are here. */
class FakeSocket {
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readyState = 0;
  sent: string[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeSocket.CLOSED;
  }

  /** Completes the handshake the way a real socket would. */
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  drop(): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.();
  }

  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }
}

function harness() {
  const sockets: FakeSocket[] = [];
  const changed: Array<[number, number]> = [];
  const live: boolean[] = [];

  const handlers: LiveHandlers = {
    changed: (vaultId, changeSeq) => {
      changed.push([vaultId, changeSeq]);
    },
    live: (up) => {
      live.push(up);
    },
  };

  const open = (): WebSocket => {
    const socket = new FakeSocket();
    sockets.push(socket);

    return socket as unknown as WebSocket;
  };

  return { sockets, changed, live, handlers, open };
}

/** Lets the promise inside connect() settle before the test looks at the socket. */
async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('live socket', () => {
  beforeEach(() => {
    vi.stubGlobal('WebSocket', FakeSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('names itself before anything else', async () => {
    const { sockets, handlers, open } = harness();

    const session = connect(handlers, { open, token: async () => 'jwt' });
    await settle();

    sockets[0]?.accept();

    expect(sockets[0]?.frames()[0]).toEqual({ type: 'auth', token: 'jwt' });

    session.close();
  });

  it('follows a vault and says so once the socket is up', async () => {
    const { sockets, handlers, open } = harness();

    const session = connect(handlers, { open, token: async () => 'jwt' });
    await settle();

    sockets[0]?.accept();
    session.follow(12);

    expect(sockets[0]?.frames()).toContainEqual({ type: 'subscribe', vault_id: 12 });

    session.close();
  });

  // A reconnect that forgot what it was following would leave the tree stale until the next
  // poll, which is the whole thing the socket exists to avoid.
  it('re-follows everything after a reconnect', async () => {
    vi.useFakeTimers();

    const { sockets, handlers, open } = harness();

    const session = connect(handlers, { open, token: async () => 'jwt' });
    await settle();

    sockets[0]?.accept();
    session.follow(12);
    session.follow(13);

    sockets[0]?.drop();

    await vi.advanceTimersByTimeAsync(RETRY_CEILING_MS);
    await settle();

    expect(sockets).toHaveLength(2);

    sockets[1]?.accept();

    const frames = sockets[1]?.frames() ?? [];
    expect(frames[0]).toEqual({ type: 'auth', token: 'jwt' });
    expect(frames).toContainEqual({ type: 'subscribe', vault_id: 12 });
    expect(frames).toContainEqual({ type: 'subscribe', vault_id: 13 });

    session.close();
  });

  it('reports a change with the sequence to catch up to', async () => {
    const { sockets, changed, handlers, open } = harness();

    const session = connect(handlers, { open, token: async () => 'jwt' });
    await settle();

    sockets[0]?.accept();
    sockets[0]?.deliver({ type: 'changed', vault_id: 12, change_seq: 9438 });

    expect(changed).toEqual([[12, 9438]]);

    session.close();
  });

  // A client older than its server has to degrade to polling, not fall over.
  it('ignores frames it does not know', async () => {
    const { sockets, changed, handlers, open } = harness();

    const session = connect(handlers, { open, token: async () => 'jwt' });
    await settle();

    sockets[0]?.accept();
    sockets[0]?.deliver({ type: 'presence', peers: [] });
    sockets[0]?.deliver({ type: 'changed', vault_id: 12, change_seq: 1 });

    expect(changed).toEqual([[12, 1]]);

    session.close();
  });

  it('announces liveness only once the server has answered', async () => {
    const { sockets, live, handlers, open } = harness();

    const session = connect(handlers, { open, token: async () => 'jwt' });
    await settle();

    sockets[0]?.accept();
    expect(live).toEqual([]);

    sockets[0]?.deliver({ type: 'ready', user_id: 7 });
    expect(live).toEqual([true]);

    sockets[0]?.drop();
    expect(live).toEqual([true, false]);

    session.close();
  });

  it('stays down once closed', async () => {
    vi.useFakeTimers();

    const { sockets, handlers, open } = harness();

    const session = connect(handlers, { open, token: async () => 'jwt' });
    await settle();

    sockets[0]?.accept();
    session.close();

    await vi.advanceTimersByTimeAsync(RETRY_CEILING_MS * 2);
    await settle();

    expect(sockets).toHaveLength(1);
  });

  // No token is not a reason to give up for good: the refresh may have failed because the
  // server was briefly unreachable, which is exactly when a retry is worth making.
  it('retries when the token cannot be had', async () => {
    vi.useFakeTimers();

    const { sockets, handlers, open } = harness();

    let attempts = 0;
    const token = async (): Promise<string> => {
      attempts += 1;
      if (attempts === 1) throw new Error('no session');

      return 'jwt';
    };

    const session = connect(handlers, { open, token });
    await settle();

    expect(sockets).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(RETRY_CEILING_MS);
    await settle();

    expect(sockets).toHaveLength(1);

    session.close();
  });
});

/** Past the widest jittered delay a first retry can draw. */
const RETRY_CEILING_MS = 5_000;
