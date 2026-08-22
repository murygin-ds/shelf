import { useEffect, useRef, useState } from 'react';

import * as mcp from '@/api/mcp';
import type { ImportProgress } from '@/api/transfer';
import type { Identity } from '@/crypto/identity';
import * as ws from '@/api/workspace';
import { useWorkspace } from '@/store/workspace';
import Checkbox from '@/ui/Checkbox';
import { useDismiss } from '@/ui/dismiss';
import { useFocusTrap } from '@/ui/trap';
import { Icon } from '@/ui/Icon';

import styles from './claude.module.css';

interface Props {
  identity: Identity;
  onClose: () => void;
}

interface Result {
  vaultId: number;
  name: string;
  notes: number;
  folders: number;
  fingerprint: string;
  secret: string;
}

const PHASES: Record<ImportProgress['phase'], string> = {
  vault: 'CREATING THE VAULT',
  folders: 'BUILDING THE TREE',
  notes: 'WRITING THE NOTES',
  links: 'LINKING',
};

/**
 * The one dialog in Shelf that asks somebody to give something up rather than to choose
 * something. It says so in as many words, twice, and will not proceed until both are ticked.
 */
export default function ClaudeVaultModal({ identity, onClose }: Props) {
  const createClaudeVault = useWorkspace((state) => state.createClaudeVault);
  const refreshVaults = useWorkspace((state) => state.refreshVaults);
  const refreshConnector = useWorkspace((state) => state.refreshConnector);

  const [name, setName] = useState('Claude');
  const [role, setRole] = useState<mcp.ConnectorRole>('editor');
  const [understood, setUnderstood] = useState(false);
  const [noSecrets, setNoSecrets] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  // undefined while the answer is still coming: the button must not be live before it.
  const [available, setAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    void mcp.available().then(setAvailable);
  }, []);

  const modal = useRef<HTMLDivElement>(null);

  // Closing mid-create would leave a vault whose key was never handed over, which is the one
  // outcome the beforeunload guard below exists to prevent. Every way out is held shut, not
  // just the two that were easy to guard.
  const close = () => {
    if (!busy) onClose();
  };

  const dismiss = useDismiss(close);

  useFocusTrap(modal);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };


    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Half a connector is worse than none: closing the tab between creating the vault and
  // sealing its key would leave a vault nobody asked for.
  useEffect(() => {
    if (!busy) return undefined;

    const hold = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', hold);

    return () => window.removeEventListener('beforeunload', hold);
  }, [busy]);

  const create = async () => {
    setBusy(true);
    setError(null);

    let made = false;

    try {
      const vaultName = name.trim() || 'Claude';
      const report = await createClaudeVault(vaultName, identity, setProgress);

      made = true;

      // Read back rather than trusted from the report: the connector has to be sealed
      // against the scope the server actually recorded.
      const vaults = await ws.listVaults(identity);
      const vault = vaults.find((candidate) => candidate.id === report.vaultId);
      const keyring = useWorkspace.getState().keyring;

      if (!vault || !keyring) throw new Error('the new vault did not come back unlocked');

      const connector = await mcp.enable(vault, role, keyring);
      const credential = await mcp.issueCredential(vault.id, 'first client');

      // The connector is a member now, so the switcher's "only you" and the missing SHARED
      // badge are both wrong until the list is read again — and that badge is the one thing
      // on that row somebody scans for.
      await refreshVaults(identity);
      // The sidebar offers the Claude view off this, so it has to know before the dialog
      // closes rather than at the next vault switch.
      await refreshConnector();

      setResult({
        vaultId: vault.id,
        name: vaultName,
        notes: report.notes,
        folders: report.folders,
        fingerprint: connector.fingerprint,
        secret: credential.secret,
      });
    } catch (cause) {
      const why = cause instanceof Error ? cause.message : 'that did not work';

      // The vault is made first and connected second. Saying only that it failed would leave
      // somebody looking for a vault they had been told was not created.
      setError(
        made
          ? `The vault was created but could not be connected: ${why}. It is in the vault menu — connect it again from there, or delete it.`
          : why,
      );
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div className={styles.overlay} {...dismiss}>
      <div ref={modal} className={styles.modal} role="dialog" aria-modal="true" tabIndex={-1}>
        <div className={styles.head}>
          <div>
            <div className={styles.title}>{result ? 'Claude is connected' : 'Connect Claude'}</div>
            <div className={styles.subtitle}>
              {result ? 'One vault, readable by this server' : 'A vault laid out as Claude’s memory'}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={close} aria-label="Close">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className={styles.body}>
          {result ? <Done result={result} /> : null}

          {!result && available === false ? <Unavailable /> : null}

          {result || available === false ? null : (
            <>
              <p className={styles.lede}>
                This creates a vault holding a ready-made structure — context, projects, skills,
                memory and an inbox — and hands its key to this server so that Claude can read and
                write it over the connector.
              </p>

              <div className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.noteIcon}>
                  <Icon name="warn" size={13} />
                </span>
                <span>
                  <strong>This server will be able to read this vault.</strong> Every folder name,
                  every title and every body. It is the only place in Shelf where that is true, and
                  it is what makes a connector possible at all. Anything Claude reads here also
                  leaves for Anthropic. Your other vaults are untouched: this server holds no key
                  to them and cannot obtain one.
                </span>
              </div>

              <div className={styles.consent}>
                <Checkbox checked={understood} onChange={setUnderstood} disabled={busy}>
                  I understand this server will hold the key to this vault, and accept it.
                </Checkbox>
                <Checkbox checked={noSecrets} onChange={setNoSecrets} disabled={busy}>
                  I will not keep passwords, keys, recovery codes or other people’s personal data
                  here.
                </Checkbox>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>VAULT NAME</span>
                <input
                  className={styles.input}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>

              <div className={styles.section}>WHAT CLAUDE MAY DO</div>
              <div className={styles.roles}>
                {(
                  [
                    ['editor', 'Read and write', 'Claude keeps its own memory and project notes.'],
                    ['viewer', 'Read only', 'Claude can look things up but never writes.'],
                  ] as const
                ).map(([value, title, hint]) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    className={`${styles.role} ${role === value ? styles.roleOn : ''}`}
                    onClick={() => setRole(value)}
                  >
                    <div className={styles.roleName}>{title}</div>
                    <div className={styles.roleHint}>{hint}</div>
                  </button>
                ))}
              </div>

              {progress ? (
                <div className={styles.progress}>
                  {PHASES[progress.phase]} {progress.done}/{progress.total}
                </div>
              ) : null}

              {error ? <div className={styles.error}>{error}</div> : null}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            {result ? 'THE CREDENTIAL IS SHOWN ONCE' : null}
            {!result && available === true ? 'REVOCABLE FROM THE VAULT MENU' : null}
            {!result && available === false ? 'NOTHING WAS CREATED' : null}
          </span>
          <span className={styles.footerSpacer} />
          {result || available === false ? (
            <button type="button" className={styles.done} onClick={onClose}>
              {result ? 'Done' : 'Close'}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !understood || !noSecrets || available !== true}
              onClick={() => void create()}
            >
              {busy ? 'Creating…' : 'Create and connect'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What the dialog says on a server that does not serve a connector.
 *
 * Shown instead of the form rather than after it: the vault is made first and connected
 * second, so a server that cannot do the second half must not be allowed to do the first.
 */
function Unavailable() {
  return (
    <>
      <p className={styles.lede}>
        This server is not set up to serve a connector, so a vault made here could not be
        connected to Claude. Nothing has been created.
      </p>

      <div className={`${styles.note} ${styles.noteWarn}`}>
        <span className={styles.noteIcon}>
          <Icon name="warn" size={13} />
        </span>
        <span>
          It is off by default, because it is the one feature that hands this server a key.
          Turning it on is three settings and a restart.
        </span>
      </div>

      <div className={styles.section}>WHAT TO SET</div>
      <code className={`${styles.code} ${styles.codeBlock}`}>
        {[
          'SHELF_MCP_ENABLED=true',
          '# at least 32 characters, and never in configs/config.yaml',
          'SHELF_MCP_SECRET=$(openssl rand -hex 32)',
          '# exactly the address Claude will be given',
          'SHELF_MCP_PUBLIC_BASE_URL=https://shelf.example.com',
        ].join('\n')}
      </code>

      <p className={styles.lede} style={{ marginTop: 10 }}>
        The secret has no fallback anywhere, local included: one generated at startup would
        make every connector key already stored unreadable after the first restart.
      </p>
    </>
  );
}

function Done({ result }: { result: Result }) {
  const url = `${window.location.origin}/api/v1/mcp`;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

  return (
    <>
      <p className={styles.lede}>
        <strong>{result.name}</strong> holds {result.notes} notes in {result.folders} folders, and
        this server now has its key.
      </p>

      <div className={styles.section}>CONNECTOR URL</div>
      <Copyable value={url} />

      {local ? (
        <div className={`${styles.note} ${styles.noteWarn}`}>
          <span className={styles.noteIcon}>
            <Icon name="warn" size={13} />
          </span>
          <span>
            Claude Desktop reaches a connector from Anthropic’s own network, so an address on this
            machine is not one it can call. Claude Code can, from here:
            <br />
            <code>claude mcp add --transport http shelf {url}</code>
          </span>
        </div>
      ) : null}

      <div className={styles.section}>CREDENTIAL</div>
      <Copyable value={`Bearer ${result.secret}`} />
      <p className={styles.lede} style={{ marginTop: 8 }}>
        Paste it whole, scheme included. It is shown once — what this server keeps is a digest, so
        a lost one is replaced rather than recovered.
      </p>

      <div className={styles.section}>KEY FINGERPRINT</div>
      <Copyable value={result.fingerprint} />

      <div className={styles.section}>TO UNDO THIS</div>
      <ol className={styles.steps}>
        <li>Remove the connector from this vault’s members.</li>
        <li>
          Rotate the vault key afterwards — removing it stops new reads, rotating is what makes the
          key it already saw useless.
        </li>
      </ol>
    </>
  );
}

function Copyable({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // A denied clipboard is not worth an error: the text is on screen and selectable.
      setCopied(false);
    }
  };

  return (
    <div className={styles.copyRow}>
      <code className={styles.code}>{value}</code>
      <button type="button" className={styles.copy} onClick={() => void copy()}>
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
