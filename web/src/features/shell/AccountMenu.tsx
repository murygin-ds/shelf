import type { MouseEvent } from 'react';

import { LANGUAGES, language, m, NAME } from '@/i18n';
import { switchLanguage } from '@/store/language';
import { usePrefs } from '@/store/prefs';
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
  const { user, identity, status, signOut, lock } = useSession();
  const setView = useWorkspace((state) => state.setView);
  const saveNote = useWorkspace((state) => state.saveNote);
  const { readOnly, setReadOnly } = usePrefs();
  const { open: openMenu, menu } = useContextMenu();
  const current = language();

  // Whatever is typed and not yet sealed goes out before the door closes. After it the
  // autosave is refused, and an unsaved body would sit in the editor with nowhere to land
  // until somebody typed into it again.
  const freeze = () => {
    void saveNote(identity ?? undefined).finally(() => setReadOnly(true));
  };

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
    {
      id: 'profile',
      label: m.shell.account.profile,
      icon: 'user',
      separated: true,
      onSelect: () => setView('profile'),
    },
    // Not a permission and not a lock: the keys stay open and every vault stays readable,
    // but nothing on this device writes to any of them until it is turned off again.
    {
      id: 'read-only',
      label: m.shell.account.readOnlyMode,
      icon: 'eye',
      ...(readOnly ? { hint: m.shell.account.readOnlyOn } : {}),
      onSelect: () => (readOnly ? setReadOnly(false) : freeze()),
    },
    // Ticked rather than labelled «current»: the row the reader is looking for is written
    // in a language they may not read, so the mark has to carry the state on its own.
    {
      kind: 'submenu',
      id: 'language',
      label: m.shell.account.language,
      icon: 'globe',
      items: LANGUAGES.map((code) => ({
        id: `language-${code}`,
        label: NAME[code],
        ...(code === current ? { icon: 'check' as const } : {}),
        onSelect: () => switchLanguage(code),
      })),
    },
    // The keys drop but the session stays, so this is not a way out — it is the lock the
    // top bar used to carry as an icon of its own.
    { id: 'lock', label: m.shell.account.lockKeys, icon: 'lock', onSelect: lock },
    {
      id: 'sign-out',
      label: m.shell.account.signOut,
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
            {status === 'unlocked' ? m.shell.account.keyUnlocked : m.shell.account.keyLocked}
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
