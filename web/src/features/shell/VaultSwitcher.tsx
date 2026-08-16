import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { Vault } from '@/api/workspace';
import { IconPicker, type PickerTarget, pickerPosition } from '@/features/sidebar/IconPicker';
import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { type ConfirmRequest, useConfirm } from '@/ui/Confirm';
import { type MenuItem, useContextMenu } from '@/ui/ContextMenu';
import { Icon, type IconName } from '@/ui/Icon';
import { useNamePrompt } from '@/ui/NamePrompt';

import styles from './vaultswitcher.module.css';

/**
 * The vault picker.
 *
 * One control rather than two: the mark used to open the icon picker and the name the vault
 * list, which read as a single button and behaved as two. Picking an icon is now a verb in
 * the menu, and the whole trigger switches vaults.
 *
 * A vault the reader owns and one they were let into are different things — the second is
 * somebody else's room — so the menu splits them and the mark carries the difference where
 * the list is not open: owned marks are filled, joined ones are outlined.
 */
export function VaultSwitcher({ onNewVault }: { onNewVault: () => void }) {
  const { identity } = useSession();
  const { vaults, vaultId, loading, selectVault, setVaultIcon, setVaultLabel, removeVault } =
    useWorkspace();

  const [open, setOpen] = useState(false);
  const [picker, setPicker] = useState<PickerTarget | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const navigate = useNavigate();
  const { ask, dialog } = useConfirm();
  const { ask: askText, dialog: textDialog } = useNamePrompt();
  const { open: openRowMenu, menu: rowMenu } = useContextMenu();

  const vault = vaults.find((item) => item.id === vaultId);

  const groups = useMemo(
    () => ({
      mine: vaults.filter((item) => item.role === 'owner'),
      joined: vaults.filter((item) => item.role !== 'owner'),
    }),
    [vaults],
  );

  useEffect(() => {
    if (!open) return;

    const close = () => setOpen(false);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', close);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', close);
    };
  }, [open]);

  const changeIcon = () => {
    const anchor = trigger.current?.getBoundingClientRect();
    if (!anchor || !vault) return;

    setOpen(false);
    setPicker({
      ...pickerPosition(anchor),
      current: vault.emoji,
      onPick: (icon) => void setVaultIcon(icon),
    });
  };

  const choose = (item: Vault) => {
    setOpen(false);
    if (identity && item.id !== vaultId) void selectVault(item.id, identity);
  };

  /**
   * A note of one's own on a vault somebody else named. Nobody but this account ever sees
   * it, so it is asked for plainly and written straight away.
   */
  const label = (item: Vault) => {
    setOpen(false);

    void askText(
      'Your label for this vault',
      item.label ?? '',
      'Only you ever see it: it is sealed to your own key, not the vault’s, so neither the other members nor the server can read it. Clear it with “Remove label”.',
    ).then((text) => {
      if (text !== null && identity) void setVaultLabel(item.id, text, identity);
    });
  };

  /** Deleting one's own vault, or walking out of somebody else's. Neither is undoable. */
  const part = (item: Vault) => {
    setOpen(false);
    const mine = item.role === 'owner';

    void ask(mine ? deleteRequest(item) : leaveRequest(item)).then((ok) => {
      if (ok && identity) void removeVault(item.id, mine ? 'delete' : 'leave', identity);
    });
  };

  const menuFor = (item: Vault): MenuItem[] => [
    ...(item.id === vaultId
      ? []
      : [{ label: 'Open', icon: 'arrow' as const, onSelect: () => choose(item) }]),
    // The picker seals through the loaded keyring, which is the open vault's alone.
    ...(item.id === vaultId && !item.locked
      ? [{ label: 'Change icon', icon: 'star' as const, onSelect: changeIcon }]
      : []),
    // Only on vaults somebody else named. Your own you can simply rename.
    ...(item.role === 'owner'
      ? []
      : [
          {
            label: item.label ? 'Edit label' : 'Add label',
            icon: 'tag' as const,
            onSelect: () => label(item),
          },
          ...(item.label
            ? [
                {
                  label: 'Remove label',
                  icon: 'x' as const,
                  onSelect: () => {
                    if (identity) void setVaultLabel(item.id, '', identity);
                  },
                },
              ]
            : []),
        ]),
    {
      // An owner cannot walk out — the vault is theirs — and nobody else can destroy it.
      ...(item.role === 'owner'
        ? { label: 'Delete vault', icon: 'trash' as const }
        : { label: 'Leave vault', icon: 'user' as const }),
      danger: true,
      separated: true,
      onSelect: () => part(item),
    },
  ];

  const group = (title: string, items: Vault[]) =>
    items.length ? (
      <>
        <div className={styles.groupHead}>
          <span>{title}</span>
          <span className={styles.groupRule} />
          <span>{items.length}</span>
        </div>
        {items.map((item) => (
          <VaultRow
            key={item.id}
            vault={item}
            active={item.id === vaultId}
            onSelect={choose}
            onMenu={(event) => openRowMenu(event, menuFor(item))}
          />
        ))}
      </>
    ) : null;

  return (
    <div className={styles.switcher}>
      {dialog}
      {textDialog}
      {rowMenu}

      <button
        ref={trigger}
        type="button"
        className={`${styles.trigger} ${open ? styles.triggerOpen : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onContextMenu={(event) => {
          event.preventDefault();
          if (vault) openRowMenu(event, menuFor(vault));
        }}
      >
        <VaultMark vault={vault} size={16} />
        <span className={styles.triggerName}>
          {vault?.name ?? (loading ? 'Loading…' : 'No vault')}
        </span>
        {vault?.label ? <span className={styles.triggerLabel}>{vault.label}</span> : null}
        {vault && vault.role !== 'owner' ? (
          <span className={styles.pill}>{vault.role.toUpperCase()}</span>
        ) : null}
        <Icon name="down" size={12} className={styles.chevron} />
      </button>

      {open ? (
        <>
          {/* Either button dismisses it. A right click that fell through would open the
              platform menu over a list that is already gone. */}
          <div
            className={styles.backdrop}
            onClick={() => setOpen(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              setOpen(false);
            }}
          />

          <div className={styles.menu} role="menu">
            <div className={styles.list}>
              {group('MINE', groups.mine)}
              {group('SHARED WITH ME', groups.joined)}

              {vaults.length === 0 ? (
                <p className={styles.empty}>
                  No vaults yet. Create one, or join with a code someone sent you.
                </p>
              ) : null}
            </div>

            <div className={styles.divider} />

            <button
              type="button"
              role="menuitem"
              className={styles.action}
              onClick={() => {
                setOpen(false);
                onNewVault();
              }}
            >
              <span className={styles.actionIcon}>
                <Icon name="plus" size={13} />
              </span>
              New vault
            </button>

            <button
              type="button"
              role="menuitem"
              className={styles.action}
              onClick={() => {
                setOpen(false);
                navigate('/join');
              }}
            >
              <span className={styles.actionIcon}>
                <Icon name="key" size={13} />
              </span>
              Join with code
            </button>

            {vault && !vault.locked ? (
              <button type="button" role="menuitem" className={styles.action} onClick={changeIcon}>
                <span className={styles.actionIcon}>
                  <Icon name="star" size={13} />
                </span>
                Change icon
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {picker ? <IconPicker target={picker} onClose={() => setPicker(null)} /> : null}
    </div>
  );
}

function VaultRow({
  vault,
  active,
  onSelect,
  onMenu,
}: {
  vault: Vault;
  active: boolean;
  onSelect: (vault: Vault) => void;
  onMenu: (event: MouseEvent) => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`${styles.row} ${active ? styles.rowActive : ''}`}
      onClick={() => onSelect(vault)}
      onContextMenu={onMenu}
    >
      <VaultMark vault={vault} size={15} />

      <span className={styles.rowText}>
        <span className={styles.rowName}>{vault.name}</span>
        {/* The label takes the meta line rather than sitting beside it: somebody who
            wrote "onboarding docs — ask Rita" wants to read that, not a note count. A
            vault with no key is the exception — that is the fact worth the line. */}
        {vault.label && !vault.locked ? (
          <span className={styles.rowLabel}>{vault.label}</span>
        ) : (
          <span className={styles.rowMeta}>{describe(vault)}</span>
        )}
      </span>

      {vault.keyState === 'pending_rotation' ? (
        <Icon name="warn" size={12} className={styles.warn} />
      ) : null}

      {vault.locked ? <Icon name="lock" size={12} className={styles.quiet} /> : null}

      {vault.role === 'owner' && vault.memberCount > 1 ? (
        <span className={styles.pill}>SHARED</span>
      ) : vault.role !== 'owner' ? (
        <span className={styles.pill}>{vault.role.toUpperCase()}</span>
      ) : null}

      {active ? <Icon name="check" size={13} className={styles.check} /> : null}
    </button>
  );
}

/** Filled for a vault of the reader's own, outlined for one they were let into. */
function VaultMark({ vault, size }: { vault: Vault | undefined; size: number }) {
  const joined = vault !== undefined && vault.role !== 'owner';

  return (
    <span
      className={[styles.mark, joined ? styles.markJoined : '', vault ? '' : styles.markEmpty]
        .filter(Boolean)
        .join(' ')}
    >
      <Icon name={(vault?.emoji as IconName) ?? 'vault'} size={size} />
    </span>
  );
}

/**
 * The name has to be typed out. Deleting a vault destroys every note in it for every
 * member, with no trash behind it — a red button one click away is not enough of a gap.
 * A locked vault has no readable name to type, so it only gets the button.
 */
function deleteRequest(vault: Vault): ConfirmRequest {
  const notes = `${vault.noteCount} note${vault.noteCount === 1 ? '' : 's'}`;
  const shared = vault.memberCount > 1 ? `, for all ${vault.memberCount} members` : '';

  return {
    title: `Delete “${vault.name}”?`,
    body: `This destroys the vault and everything in it — ${notes}${shared}. The server keeps only ciphertext and deletes it; no key anyone kept will bring it back.`,
    confirmLabel: 'Delete vault',
    ...(vault.locked ? {} : { requireText: vault.name }),
  };
}

function leaveRequest(vault: Vault): ConfirmRequest {
  return {
    title: `Leave “${vault.name}”?`,
    body: 'You lose access to it right away, and your keys for it are deleted here and on the server. Nothing you wrote is removed, and an admin has to invite you again to get back in.',
    confirmLabel: 'Leave vault',
  };
}

function describe(vault: Vault): string {
  // A locked vault has no readable name either, so its counts would be the only thing on the
  // row that says anything — and what it says is "you cannot open this".
  if (vault.locked) return 'No key yet';

  const notes = `${vault.noteCount} note${vault.noteCount === 1 ? '' : 's'}`;

  return vault.memberCount === 1
    ? `${notes} · only you`
    : `${notes} · ${vault.memberCount} members`;
}
