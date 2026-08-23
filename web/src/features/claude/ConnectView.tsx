import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '@/api/client';
import { describe } from '@/api/errors';
import * as mcp from '@/api/mcp';
import { m } from '@/i18n';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './claude.module.css';

interface ClientInfo {
  client_id: string;
  client_name: string;
}

/**
 * The consent screen an OAuth client is sent to.
 *
 * It is a page rather than a server-rendered form on purpose: the security headers set
 * `form-action 'none'`, so a form posted from this origin would be stopped by the browser.
 * Approving is a fetch, and only the redirect afterwards is a navigation.
 */
export default function ConnectView() {
  const [params] = useSearchParams();
  const { identity } = useSession();
  const vaults = useWorkspace((state) => state.vaults);
  const loadVaults = useWorkspace((state) => state.load);
  const loaded = useWorkspace((state) => state.loaded);

  // An OAuth redirect is always a cold navigation: this route is a sibling of the workspace,
  // never a child of it, so nothing has read the vault list yet. Without this the screen can
  // only ever say there is nothing to grant.
  useEffect(() => {
    if (identity && !loaded) void loadVaults(identity);
  }, [identity, loaded, loadVaults]);

  const clientID = params.get('client_id') ?? '';
  const redirectURI = params.get('redirect_uri') ?? '';
  const challenge = params.get('code_challenge') ?? '';
  const method = params.get('code_challenge_method') ?? 'S256';
  const state = params.get('state') ?? '';

  const [client, setClient] = useState<ClientInfo | null>(null);
  const [unknownClient, setUnknownClient] = useState(false);
  const [connected, setConnected] = useState<number[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientID) return undefined;

    let cancelled = false;

    // Reset first: navigating from one link to another must not leave the previous client's
    // name above a different client's request.
    setClient(null);
    setUnknownClient(false);

    void api
      .get<ClientInfo>(`/oauth/client?client_id=${encodeURIComponent(clientID)}`)
      .then((found) => {
        if (!cancelled) setClient(found);
      })
      .catch(() => {
        if (!cancelled) setUnknownClient(true);
      });

    return () => {
      cancelled = true;
    };
  }, [clientID]);

  // Only a vault that already has a connector can be granted: consenting is agreeing to let
  // a client reach a key the server was given, not agreeing to give it one.
  useEffect(() => {
    let cancelled = false;

    void Promise.all(vaults.map((vault) => mcp.connector(vault.id))).then((found) => {
      if (cancelled) return;

      const ready = found
        .filter((entry): entry is mcp.Connector => entry !== null && entry.ready)
        .map((entry) => entry.vaultId);

      setConnected(ready);
      setChosen((current) => current ?? ready[0] ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [vaults]);

  const problem = (() => {
    if (!clientID || !redirectURI || !challenge) return m.claude.consent.linkIncomplete;
    if (method !== 'S256') return m.claude.consent.methodRefused;
    // Until the registration resolves there is nothing to consent to, and an unresolved one
    // must not leave Allow live over an address nobody registered.
    if (unknownClient) return m.claude.consent.clientUnknown;

    return null;
  })();

  const approve = async () => {
    if (chosen === null) return;

    setBusy(true);
    setError(null);

    try {
      const redirect = await mcp.approve({
        vaultId: chosen,
        clientId: clientID,
        redirectUri: redirectURI,
        codeChallenge: challenge,
        ...(state ? { state } : {}),
      });

      window.location.assign(redirect);
    } catch (cause) {
      setError(describe(cause));
      setBusy(false);
    }
  };

  const named = vaults.filter((vault) => connected.includes(vault.id));

  // Denying sends the client the refusal OAuth defines, so it stops waiting rather than
  // hanging on a window that was closed.
  const deny = () => {
    if (!redirectURI || problem) {
      window.location.assign('/');

      return;
    }

    const back = new URL(redirectURI);
    back.searchParams.set('error', 'access_denied');

    if (state) back.searchParams.set('state', state);

    window.location.assign(back.toString());
  };

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{m.claude.consent.title}</div>
            <div className={styles.subtitle}>
              {problem ? m.claude.consent.nothing : null}
              {/* The name is half a sentence, so it waits for the answer rather than being
                  written into one: «checking who is asking» is not who is asking. */}
              {!problem && client
                ? m.claude.consent.asking(client.client_name || m.claude.consent.someClient)
                : null}
              {!problem && !client ? m.claude.consent.checking : null}
            </div>
          </div>
        </div>

        <div className={styles.body}>
          {problem ? <div className={styles.error}>{problem}</div> : null}

          {!problem && client && loaded && named.length === 0 ? (
            <div className={`${styles.note} ${styles.noteWarn}`}>
              <span className={styles.noteIcon}>
                <Icon name="warn" size={13} />
              </span>
              <span>
                {m.claude.consent.noneBefore}
                <strong> {m.claude.consent.menuItem}</strong> {m.claude.consent.noneAfter}
              </span>
            </div>
          ) : null}

          {!problem && client && named.length > 0 ? (
            <>
              <p className={styles.lede}>
                {named.length === 1 ? m.claude.consent.ledeOne : m.claude.consent.ledeMany}
              </p>

              <div className={styles.section}>{m.claude.consent.vaultSection}</div>
              <div className={styles.roles} style={{ flexWrap: 'wrap' }}>
                {named.map((vault) => (
                  <button
                    key={vault.id}
                    type="button"
                    className={`${styles.role} ${chosen === vault.id ? styles.roleOn : ''}`}
                    onClick={() => setChosen(vault.id)}
                  >
                    <div className={styles.roleName}>{vault.name}</div>
                    <div className={styles.roleHint}>{m.claude.consent.notes(vault.noteCount)}</div>
                  </button>
                ))}
              </div>

              <div className={styles.section}>{m.claude.consent.returning}</div>
              {/* Block, not inline: overflow does not apply to an inline element, so an
                  address longer than the modal would be clipped rather than scrolled —
                  directly under the line telling somebody to read it. */}
              <code className={`${styles.code} ${styles.codeBlock}`}>{redirectURI}</code>

              <div className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.noteIcon}>
                  <Icon name="warn" size={13} />
                </span>
                <span>{m.claude.consent.addressNote}</span>
              </div>
            </>
          ) : null}

          {error ? <div className={styles.error}>{error}</div> : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            {problem || chosen === null ? '' : m.claude.consent.footerKey}
          </span>
          <span className={styles.footerSpacer} />
          {/* Refusing has to be as reachable as agreeing, and every error state above is
              otherwise a screen with no way out of it. */}
          <button type="button" className={styles.done} disabled={busy} onClick={deny}>
            {problem ? m.common.close : m.claude.consent.deny}
          </button>
          <button
            type="button"
            className={styles.primary}
            disabled={busy || Boolean(problem) || !client || chosen === null}
            onClick={() => void approve()}
          >
            {busy ? m.claude.consent.approving : m.claude.consent.allow}
          </button>
        </div>
      </div>
    </div>
  );
}
