import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { api } from '@/api/client';
import * as mcp from '@/api/mcp';
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
  const vaults = useWorkspace((state) => state.vaults);

  const clientID = params.get('client_id') ?? '';
  const redirectURI = params.get('redirect_uri') ?? '';
  const challenge = params.get('code_challenge') ?? '';
  const method = params.get('code_challenge_method') ?? 'S256';
  const state = params.get('state') ?? '';

  const [client, setClient] = useState<ClientInfo | null>(null);
  const [connected, setConnected] = useState<number[]>([]);
  const [chosen, setChosen] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clientID) return;

    void api
      .get<ClientInfo>(`/oauth/client?client_id=${encodeURIComponent(clientID)}`)
      .then(setClient)
      .catch(() => setError('That client is not registered with this server.'));
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
    if (!clientID || !redirectURI || !challenge) return 'This link is missing what it needs.';
    if (method !== 'S256') return 'This client asked for a challenge method this server refuses.';

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
      setError(cause instanceof Error ? cause.message : 'that did not work');
      setBusy(false);
    }
  };

  const named = vaults.filter((vault) => connected.includes(vault.id));

  return (
    <div className={styles.overlay}>
      <div className={styles.modal}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>Connect to Shelf</div>
            <div className={styles.subtitle}>
              {client ? client.client_name || 'An MCP client' : 'Checking who is asking…'} wants to
              reach one of your vaults
            </div>
          </div>
        </div>

        <div className={styles.body}>
          {problem ? <div className={styles.error}>{problem}</div> : null}

          {!problem && named.length === 0 ? (
            <div className={`${styles.note} ${styles.noteWarn}`}>
              <span className={styles.noteIcon}>
                <Icon name="warn" size={13} />
              </span>
              <span>
                None of your vaults has a connector yet. Set one up from the vault menu —
                <strong> Connect Claude…</strong> — and come back to this link.
              </span>
            </div>
          ) : null}

          {!problem && named.length > 0 ? (
            <>
              <p className={styles.lede}>
                Approving lets this client read
                {named.length === 1 ? ' the vault below' : ' the vault you pick'} through the
                connector, and write to it where the connector may. It does not give the client
                anything else in your account.
              </p>

              <div className={styles.section}>VAULT</div>
              <div className={styles.roles} style={{ flexWrap: 'wrap' }}>
                {named.map((vault) => (
                  <button
                    key={vault.id}
                    type="button"
                    className={`${styles.role} ${chosen === vault.id ? styles.roleOn : ''}`}
                    onClick={() => setChosen(vault.id)}
                  >
                    <div className={styles.roleName}>{vault.name}</div>
                    <div className={styles.roleHint}>{vault.noteCount} notes</div>
                  </button>
                ))}
              </div>

              <div className={styles.section}>RETURNING TO</div>
              <code className={styles.code}>{redirectURI}</code>

              <div className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.noteIcon}>
                  <Icon name="warn" size={13} />
                </span>
                <span>
                  Check that address. It is where the client will be handed the code, and a
                  loopback one belongs to whatever is listening on this machine.
                </span>
              </div>
            </>
          ) : null}

          {error ? <div className={styles.error}>{error}</div> : null}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>THIS SERVER ALREADY HOLDS THAT VAULT’S KEY</span>
          <span className={styles.footerSpacer} />
          <button
            type="button"
            className={styles.primary}
            disabled={busy || Boolean(problem) || chosen === null}
            onClick={() => void approve()}
          >
            {busy ? 'Approving…' : 'Allow'}
          </button>
        </div>
      </div>
    </div>
  );
}
