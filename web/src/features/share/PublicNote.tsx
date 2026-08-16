import { useEffect, useState } from 'react';

import { ApiError } from '@/api/client';
import * as shareApi from '@/api/share';
import { isShareSecretShaped, normalizeShareSecret } from '@/crypto/sharelink';

import styles from './share.module.css';

type State =
  | { status: 'loading' }
  | { status: 'ready'; note: shareApi.PublicNote }
  | { status: 'gone' }
  | { status: 'error'; message: string };

/**
 * A shared note, opened by whoever holds the link and nobody else.
 *
 * The secret is read from the URL fragment, which a browser never sends: the server is
 * asked with a digest of it and answers with ciphertext, so this page is the only place
 * the note exists in the clear.
 */
export function PublicNote() {
  const [state, setState] = useState<State>({ status: 'loading' });

  const [hash, setHash] = useState(window.location.hash);

  // A second link opened in the same tab changes only the fragment, which is not a
  // navigation: without this the first note would stay on screen under the new URL.
  useEffect(() => {
    const onHash = () => setHash(window.location.hash);

    window.addEventListener('hashchange', onHash);

    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    setState({ status: 'loading' });

    const secret = normalizeShareSecret(hash.replace(/^#/, ''));

    if (!isShareSecretShaped(secret)) {
      setState({ status: 'gone' });
      return;
    }

    let cancelled = false;

    shareApi
      .openShared(secret)
      .then((note) => {
        if (!cancelled) setState({ status: 'ready', note });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;

        // Every reason a link fails answers the same way on the server, so there is one
        // thing to say here: it does not open. Guessing at which reason would invent
        // information nobody has.
        if (cause instanceof ApiError && cause.status === 404) {
          setState({ status: 'gone' });
          return;
        }

        setState({ status: 'error', message: describe(cause) });
      });

    return () => {
      cancelled = true;
    };
  }, [hash]);

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <span className={styles.brand}>Shelf</span>
        <span className={styles.badge}>READ-ONLY · DECRYPTED IN YOUR BROWSER</span>
      </header>

      <main className={styles.sheet}>
        {state.status === 'loading' ? <p className={styles.quiet}>Opening…</p> : null}

        {state.status === 'gone' ? (
          <>
            <h1 className={styles.title}>This link does not open a note</h1>
            <p className={styles.lede}>
              It may have been revoked, expired, or had its key rotated — and it may never
              have existed. The server answers all of those the same way on purpose, so a
              link cannot be used to find out which.
            </p>
          </>
        ) : null}

        {state.status === 'error' ? (
          <>
            <h1 className={styles.title}>Something went wrong</h1>
            <p className={styles.lede}>{state.message}</p>
          </>
        ) : null}

        {state.status === 'ready' ? (
          <>
            <h1 className={styles.title}>{state.note.name}</h1>
            <p className={styles.meta}>
              Published {new Date(state.note.publishedAt).toLocaleString()}
            </p>
            <article className={styles.body}>{state.note.body}</article>
            <p className={styles.lede}>
              This is the note as it was when the link was made. Later edits are not
              published — an edit that has already been served cannot be recalled.
            </p>
          </>
        ) : null}
      </main>

      <footer className={styles.foot}>
        The server that served this page stores only ciphertext and the digest of the link.
        It cannot read what you are reading.
      </footer>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message || `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.message || cause.name;

  return 'the note could not be opened';
}
