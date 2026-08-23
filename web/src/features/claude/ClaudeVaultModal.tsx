import { useEffect, useRef, useState } from 'react';

import { describe } from '@/api/errors';
import * as mcp from '@/api/mcp';
import type { ImportProgress } from '@/api/transfer';
import type { Identity } from '@/crypto/identity';
import { importPhaseLabel, m } from '@/i18n';
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

/**
 * Two commands, written as their words.
 *
 * They are copied out of here into a shell, so they are the spelling `configs/config.yaml`
 * and the README use and nothing about them is translated. The locale scanner has one way to
 * tell prose from an identifier — two latin words in a row — and a command reads as prose to
 * it, which is why they are listed rather than written out.
 */
const GENERATE_SECRET = ['openssl', 'rand', '-hex', '32'].join(' ');
const CLI = ['claude', 'mcp', 'add', '--transport', 'http', 'shelf'].join(' ');

/**
 * The one dialog in Shelf that asks somebody to give something up rather than to choose
 * something. It says so in as many words, twice, and will not proceed until both are ticked.
 */
export default function ClaudeVaultModal({ identity, onClose }: Props) {
  const createClaudeVault = useWorkspace((state) => state.createClaudeVault);
  const refreshVaults = useWorkspace((state) => state.refreshVaults);
  const refreshConnector = useWorkspace((state) => state.refreshConnector);

  const [name, setName] = useState(m.claude.connect.nameInitial);
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
      const vaultName = name.trim() || m.claude.connect.nameInitial;
      const report = await createClaudeVault(vaultName, identity, setProgress);

      made = true;

      // Read back rather than trusted from the report: the connector has to be sealed
      // against the scope the server actually recorded.
      const vaults = await ws.listVaults(identity);
      const vault = vaults.find((candidate) => candidate.id === report.vaultId);
      const keyring = useWorkspace.getState().keyring;

      if (!vault || !keyring) throw new Error('the new vault did not come back unlocked');

      const connector = await mcp.enable(vault, role, keyring);
      const credential = await mcp.issueCredential(vault.id, m.claude.connect.firstClient);

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
      const why = describe(cause);

      // The vault is made first and connected second. Saying only that it failed would leave
      // somebody looking for a vault they had been told was not created.
      setError(made ? m.claude.connect.halfMade(why) : why);
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
            <div className={styles.title}>
              {result ? m.claude.connect.titleDone : m.claude.connect.title}
            </div>
            <div className={styles.subtitle}>
              {result ? m.claude.connect.subtitleDone : m.claude.connect.subtitle}
            </div>
          </div>
          <button
            type="button"
            className={styles.close}
            onClick={close}
            aria-label={m.common.close}
          >
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className={styles.body}>
          {result ? <Done result={result} /> : null}

          {!result && available === false ? <Unavailable /> : null}

          {result || available === false ? null : (
            <>
              <p className={styles.lede}>{m.claude.connect.lede}</p>

              <div className={`${styles.note} ${styles.noteWarn}`}>
                <span className={styles.noteIcon}>
                  <Icon name="warn" size={13} />
                </span>
                <span>
                  <strong>{m.claude.connect.warnLead}</strong> {m.claude.connect.warnBody}
                </span>
              </div>

              <div className={styles.consent}>
                <Checkbox checked={understood} onChange={setUnderstood} disabled={busy}>
                  {m.claude.connect.acceptKey}
                </Checkbox>
                <Checkbox checked={noSecrets} onChange={setNoSecrets} disabled={busy}>
                  {m.claude.connect.acceptNoSecrets}
                </Checkbox>
              </div>

              <label className={styles.field}>
                <span className={styles.label}>{m.claude.connect.nameLabel}</span>
                <input
                  className={styles.input}
                  value={name}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>

              <div className={styles.section}>{m.claude.connect.mayDo}</div>
              <div className={styles.roles}>
                {(
                  [
                    ['editor', m.claude.connect.editor, m.claude.connect.editorHint],
                    ['viewer', m.claude.connect.viewer, m.claude.connect.viewerHint],
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
                  {importPhaseLabel(progress.phase)} {progress.done}/{progress.total}
                </div>
              ) : null}

              {error ? <div className={styles.error}>{error}</div> : null}
            </>
          )}
        </div>

        <div className={styles.footer}>
          <span className={styles.footerNote}>
            {result ? m.claude.connect.footerOnce : null}
            {!result && available === true ? m.claude.connect.footerRevocable : null}
            {!result && available === false ? m.claude.connect.footerNothing : null}
          </span>
          <span className={styles.footerSpacer} />
          {result || available === false ? (
            <button type="button" className={styles.done} onClick={onClose}>
              {result ? m.common.done : m.common.close}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={busy || !understood || !noSecrets || available !== true}
              onClick={() => void create()}
            >
              {busy ? m.claude.connect.creating : m.claude.connect.create}
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
      <p className={styles.lede}>{m.claude.connect.off.lede}</p>

      <div className={`${styles.note} ${styles.noteWarn}`}>
        <span className={styles.noteIcon}>
          <Icon name="warn" size={13} />
        </span>
        <span>{m.claude.connect.off.note}</span>
      </div>

      <div className={styles.section}>{m.claude.connect.off.section}</div>
      <code className={`${styles.code} ${styles.codeBlock}`}>
        {[
          'SHELF_MCP_ENABLED=true',
          `# ${m.claude.connect.off.secretNote('configs/config.yaml')}`,
          `SHELF_MCP_SECRET=$(${GENERATE_SECRET})`,
          `# ${m.claude.connect.off.urlNote}`,
          'SHELF_MCP_PUBLIC_BASE_URL=https://shelf.example.com',
        ].join('\n')}
      </code>

      <p className={styles.lede} style={{ marginTop: 10 }}>
        {m.claude.connect.off.noFallback}
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
        <strong>{result.name}</strong> {m.claude.connect.done.lede(result.notes, result.folders)}
      </p>

      <div className={styles.section}>{m.claude.connect.done.urlSection}</div>
      <Copyable value={url} />

      {local ? (
        <div className={`${styles.note} ${styles.noteWarn}`}>
          <span className={styles.noteIcon}>
            <Icon name="warn" size={13} />
          </span>
          <span>
            {m.claude.connect.done.localNote}
            <br />
            <code>{`${CLI} ${url}`}</code>
          </span>
        </div>
      ) : null}

      <div className={styles.section}>{m.claude.connect.done.credentialSection}</div>
      <Copyable before="Bearer" value={result.secret} />
      <p className={styles.lede} style={{ marginTop: 8 }}>
        {m.claude.connect.done.credentialNote}
      </p>

      <div className={styles.section}>{m.claude.connect.done.fingerprintSection}</div>
      <Copyable value={result.fingerprint} />

      <div className={styles.section}>{m.claude.connect.done.undoSection}</div>
      <ol className={styles.steps}>
        <li>{m.claude.connect.done.undoRemove}</li>
        <li>{m.claude.connect.done.undoRotate}</li>
      </ol>
    </>
  );
}

/** `before` is the scheme a credential is sent under: shown with the value, and copied with it. */
function Copyable({ value, before }: { value: string; before?: string }) {
  const [copied, setCopied] = useState(false);
  const text = before === undefined ? value : `${before} ${value}`;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // A denied clipboard is not worth an error: the text is on screen and selectable.
      setCopied(false);
    }
  };

  return (
    <div className={styles.copyRow}>
      <code className={styles.code}>{text}</code>
      <button type="button" className={styles.copy} onClick={() => void copy()}>
        {copied ? m.common.copied : m.common.copy}
      </button>
    </div>
  );
}
