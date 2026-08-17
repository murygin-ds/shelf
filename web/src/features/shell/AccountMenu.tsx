import type { MouseEvent } from 'react';

import { useSession } from '@/store/session';
import { useWorkspace } from '@/store/workspace';
import { type MenuEntry, useContextMenu } from '@/ui/ContextMenu';
import { Icon } from '@/ui/Icon';

import styles from './shell.module.css';

/** The header panel draws itself before React measures it, so it declares its own height. */
const HEAD_H = 56;

/**
 * Whoever is signed in, and the verbs that belong to the account rather than to a vault.
 *
 * One control where a row of unlabelled buttons used to be: the face says whose keys are
 * open, and everything that can be done with them is one click away instead of guessed at
 * from an icon.
 */
export function AccountMenu() {
  const { user, status, signOut, lock } = useSession();
  const setView = useWorkspace((state) => state.setView);
  const { open: openMenu, menu } = useContextMenu();

  const name = user?.display_name ?? '';
  const initials =
    name
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || '?';

  const items: MenuEntry[] = [
    {
      kind: 'panel',
      height: HEAD_H,
      render: () => (
        <div className={styles.accountHead}>
          <span className={styles.avatar}>{initials}</span>
          <span className={styles.accountHeadText}>
            <span className={styles.accountHeadName}>{name}</span>
            <span className={styles.accountHeadMeta}>{user?.login}</span>
          </span>
        </div>
      ),
    },
    { label: 'Profile', icon: 'user', separated: true, onSelect: () => setView('profile') },
    // The keys drop but the session stays, so this is not a way out — it is the lock the
    // top bar used to carry as an icon of its own.
    { label: 'Lock keys', icon: 'lock', onSelect: lock },
    {
      label: 'Sign out',
      icon: 'arrow',
      danger: true,
      separated: true,
      onSelect: () => void signOut(),
    },
  ];

  return (
    <>
      {menu}

      <button
        type="button"
        className={styles.account}
        aria-haspopup="menu"
        onClick={(event) => openMenu(anchor(event), items)}
      >
        <span className={styles.avatar}>{initials}</span>
        <span className={styles.accountText}>
          <span className={styles.accountName}>{name}</span>
          <span className={styles.accountState}>
            {status === 'unlocked' ? 'KEY UNLOCKED' : 'KEY LOCKED'}
          </span>
        </span>
        <Icon name="down" size={12} className={styles.accountChevron} />
      </button>
    </>
  );
}

/**
 * Under the trigger rather than under the pointer: a menu opened by a left click on a
 * button reads as that button's own list. The right edge is asked for and the menu clamps
 * itself back inside the viewport, which is what aligns it under a control this close to
 * the corner.
 */
function anchor(event: MouseEvent<HTMLButtonElement>) {
  const rect = event.currentTarget.getBoundingClientRect();

  return {
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
    clientX: rect.right,
    clientY: rect.bottom + 6,
  };
}
