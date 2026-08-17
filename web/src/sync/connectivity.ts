/**
 * Whether the server can actually be reached, as opposed to whether the browser believes it
 * has a network.
 *
 * `navigator.onLine` only answers the second question, and it is wrong about the first one
 * in both directions: a captive portal reports online, a server that is down reports
 * nothing at all. So the browser's flag is taken as a veto — it is never wrong about having
 * no interface at all — and everything past that is decided by how the requests that were
 * actually sent came back.
 */

type Listener = (online: boolean) => void;

const listeners = new Set<Listener>();

function browserHasNetwork(): boolean {
  // Only an explicit `false` counts. Outside a browser there is no such flag, and reading a
  // missing one as "offline" would leave every request unsent.
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

let online = browserHasNetwork();

export function isOnline(): boolean {
  return online;
}

/** A request came back. Whatever the server said, something answered. */
export function markReachable(): void {
  set(true);
}

/** A request never reached the server. */
export function markUnreachable(): void {
  set(false);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

function set(next: boolean): void {
  if (online === next) return;

  online = next;
  for (const listener of listeners) listener(next);
}

if (typeof window !== 'undefined') {
  // Losing the interface is the one thing the browser knows before any request can find out.
  window.addEventListener('offline', () => set(false));

  // Regaining it is not proof the server is up, but it is reason enough to try again — and
  // the try is what drains the outbox. A server that is still down puts this back within a
  // poll.
  window.addEventListener('online', () => set(true));
}
