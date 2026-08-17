/**
 * The socket that tells this tab a vault has moved.
 *
 * It carries hints, not data: a frame says how far a vault's change sequence has run, and
 * the client pulls the delta through the endpoint it already uses. Pushing the rows
 * themselves would mean a second way to apply a change, kept in agreement with the first.
 *
 * The socket is an accelerator rather than a channel of its own. Polling continues at a
 * slower cadence while it is up, so a hub that dies takes latency with it and nothing else.
 */

import { socketToken } from '@/api/client';
import { FRAME, type ServerFrame } from '@/api/realtime';
import * as connectivity from '@/sync/connectivity';

export const PATH = '/api/v1/realtime';

/** Backoff for a socket that will not stay up. Jittered, so tabs do not reconnect in step. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * How often the socket renews itself. The access token lives fifteen minutes and an editing
 * session lives hours, so the alternative to renewing is reconnecting — which loses the
 * subscriptions and the room with them.
 */
const REAUTH_MS = 5 * 60_000;

export interface LiveHandlers {
  /** A vault moved. The cursor is what the puller compares against its own. */
  changed(vaultId: number, changeSeq: number): void;
  /** Whether hints are arriving at all. Drives how hard the poller has to work. */
  live(up: boolean): void;
  /**
   * Everything else. The editing room reads its own frames from here rather than through a
   * second socket: one connection per tab means one handshake and one keepalive.
   */
  frame?(frame: ServerFrame): void;
}

/** Seams for the tests: node has no location, and a real socket needs a real server. */
export interface LiveDeps {
  open?: () => WebSocket;
  token?: () => Promise<string>;
}

export interface LiveSession {
  /** Follows a vault, and keeps following it across reconnects. */
  follow(vaultId: number): void;
  /** Sends one frame, if the socket is up. A frame sent while it is down is dropped: the
   *  room replays what matters when it comes back, and a queue would replay stale carets. */
  send(frame: Record<string, unknown>): void;
  /** Stops for good. A session closed here does not reconnect. */
  close(): void;
}

/** Where the socket lives, in the scheme the page was served over. */
export function endpoint(): string {
  const url = new URL(PATH, window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  return url.toString();
}

export function connect(handlers: LiveHandlers, deps: LiveDeps = {}): LiveSession {
  const open = deps.open ?? (() => new WebSocket(endpoint()));
  const token = deps.token ?? socketToken;

  const followed = new Set<number>();

  let socket: WebSocket | null = null;
  let attempt = 0;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let renew: ReturnType<typeof setInterval> | null = null;
  let up = false;

  function setUp(next: boolean): void {
    if (up === next) return;

    up = next;
    handlers.live(next);
  }

  function send(frame: Record<string, unknown>): void {
    if (socket?.readyState !== WebSocket.OPEN) return;

    socket.send(JSON.stringify(frame));
  }

  function scheduleRetry(): void {
    if (stopped || retry !== null) return;

    // Full jitter: the delay is anywhere up to the ceiling, so a server coming back does
    // not meet every tab it dropped at the same instant.
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** attempt);
    const delay = RETRY_MIN_MS + Math.random() * (ceiling - RETRY_MIN_MS);

    attempt += 1;
    retry = setTimeout(() => {
      retry = null;
      void start();
    }, delay);
  }

  function teardown(): void {
    if (renew !== null) {
      clearInterval(renew);
      renew = null;
    }

    setUp(false);
  }

  async function start(): Promise<void> {
    if (stopped || socket !== null) return;

    let credential: string;
    try {
      credential = await token();
    } catch {
      // No token means no session to hold open. Retrying costs nothing and covers the case
      // where the refresh failed because the server was briefly unreachable.
      scheduleRetry();

      return;
    }

    if (stopped) return;

    let ws: WebSocket;
    try {
      ws = open();
    } catch {
      scheduleRetry();

      return;
    }

    socket = ws;

    ws.onopen = (): void => {
      attempt = 0;
      send({ type: 'auth', token: credential });

      for (const vaultId of followed) send({ type: 'subscribe', vault_id: vaultId });

      renew = setInterval(() => {
        void token()
          .then((fresh) => send({ type: 'auth', token: fresh }))
          .catch(() => {
            // The next reconnect will try again; a socket without a live token is closed
            // by the server anyway.
          });
      }, REAUTH_MS);
    };

    ws.onmessage = (event: MessageEvent): void => {
      if (typeof event.data !== 'string') return;

      let frame: ServerFrame;
      try {
        frame = JSON.parse(event.data) as ServerFrame;
      } catch {
        return;
      }

      receive(frame);
    };

    ws.onclose = (): void => {
      socket = null;
      teardown();
      scheduleRetry();
    };

    // An error is always followed by a close, which is where the reconnect is scheduled.
    ws.onerror = (): void => {};
  }

  function receive(frame: ServerFrame): void {
    switch (frame.type) {
      case FRAME.ready:
        // The socket answering at all is proof the server is there — the same signal a
        // completed request gives, and the poller reads it from the same place.
        connectivity.markReachable();
        setUp(true);
        break;

      case FRAME.changed:
        if (frame.vault_id !== undefined && frame.change_seq !== undefined) {
          handlers.changed(frame.vault_id, frame.change_seq);
        }

        break;

      default:
        // Anything else belongs to the editing room, which reads it from here. A frame
        // nobody claims is ignored rather than fatal: a client older than its server must
        // degrade to polling, not fall over.
        handlers.frame?.(frame);
    }
  }

  void start();

  return {
    follow(vaultId: number): void {
      followed.add(vaultId);
      send({ type: FRAME.subscribe, vault_id: vaultId });
    },

    send,

    close(): void {
      stopped = true;

      if (retry !== null) {
        clearTimeout(retry);
        retry = null;
      }

      teardown();
      socket?.close();
      socket = null;
    },
  };
}
