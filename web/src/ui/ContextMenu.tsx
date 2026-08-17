import {
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from 'react';

import { Icon, type IconName } from './Icon';
import { clampToViewport } from './position';
import styles from './contextmenu.module.css';

export interface MenuItem {
  /** Optional, so a plain `{ label, onSelect }` literal still reads as one of these. */
  kind?: 'item';
  label: string;
  icon?: IconName;
  onSelect: () => void;
  /** Destructive actions read differently and sit behind a separator. */
  danger?: boolean;
  separated?: boolean;
  /** Shown dim on the right: the key that does the same thing. */
  hint?: string;
}

export interface MenuSubmenu {
  kind: 'submenu';
  label: string;
  icon?: IconName;
  separated?: boolean;
  items: MenuEntry[];
}

export interface MenuPanel {
  kind: 'panel';
  /** Its own height: the menu has to be placed before React has drawn anything. */
  height: number;
  separated?: boolean;
  render: (close: () => void) => ReactNode;
}

export type MenuEntry = MenuItem | MenuSubmenu | MenuPanel;

/** What the keyboard hints call the modifier key on this platform. */
export const MOD =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.userAgent) ? '⌘' : 'Ctrl+';

/** Everything the menu needs from the event that opened it, React's or the DOM's. */
export interface MenuEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
  clientX: number;
  clientY: number;
}

interface Request {
  x: number;
  y: number;
  items: MenuEntry[];
}

const ITEM_H = 30;
const SEPARATOR_H = 7;
const PADDING = 12;
const WIDTH = 200;
const GAP = 4;

/**
 * The app's own right-click menu.
 *
 * The platform menu is not wrong so much as unrelated: it offers reload and view-source over
 * a note tree whose actual verbs are rename, re-icon and trash. Suppressing it is only worth
 * doing if something takes its place, which is what this is.
 *
 * Shaped like `useNamePrompt`: `open(event, items)` from a handler, and `menu` rendered
 * wherever the caller likes.
 */
export function useContextMenu(): {
  open: (event: MenuEvent, items: MenuEntry[]) => void;
  menu: ReactElement | null;
} {
  const [request, setRequest] = useState<Request | null>(null);

  const open = useCallback((event: MenuEvent, items: MenuEntry[]) => {
    event.preventDefault();
    event.stopPropagation();

    setRequest({ x: event.clientX, y: event.clientY, items });
  }, []);

  // Stable, so the menu's window listeners are not torn down and re-added on every render
  // of the tree it is opened over.
  const close = useCallback(() => setRequest(null), []);

  const menu = request ? <ContextMenu request={request} onClose={close} /> : null;

  return { open, menu };
}

function heightOf(items: readonly MenuEntry[]): number {
  return items.reduce(
    (sum, item) =>
      sum + (item.kind === 'panel' ? item.height : ITEM_H) + (item.separated ? SEPARATOR_H : 0),
    PADDING,
  );
}

function ContextMenu({ request, onClose }: { request: Request; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    // Scrolling moves whatever the menu was opened over, so a menu that stayed put would be
    // pointing at a different row than the one it acts on.
    window.addEventListener('keydown', onKey);
    window.addEventListener('blur', onClose);
    window.addEventListener('scroll', onClose, true);

    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const { x, y } = clampToViewport(request.x, request.y, {
    width: WIDTH,
    height: heightOf(request.items),
  });

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} onContextMenu={swallow(onClose)} />

      <Panel items={request.items} x={x} y={y} onClose={onClose} />
    </>
  );
}

/**
 * The right button over the menu itself. The stop matters as much as the prevent: without it
 * the event reaches the window-level fallback, which would answer by opening a second menu
 * on top of this one.
 */
function swallow(then?: () => void) {
  return (event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    then?.();
  };
}

interface Placement {
  items: MenuEntry[];
  x: number;
  y: number;
}

/**
 * One level of the menu. A submenu is the same component again, placed beside the row that
 * opened it and rendered as a sibling rather than a child — nesting it would have it clipped
 * by the parent's own rounded box.
 */
function Panel({ items, x, y, onClose }: Placement & { onClose: () => void }) {
  const [sub, setSub] = useState<Placement | null>(null);

  const openSub = (anchor: DOMRect, entry: MenuSubmenu) => {
    const size = { width: WIDTH, height: heightOf(entry.items) };

    // Flips to the left when there is no room on the right: `clampToViewport` would only
    // slide it back over its own parent, which is unreadable.
    const beside =
      anchor.right + size.width + GAP > window.innerWidth
        ? anchor.left - size.width + GAP
        : anchor.right - GAP;

    setSub({ items: entry.items, ...clampToViewport(beside, anchor.top - 6, size) });
  };

  return (
    <>
      <div
        className={styles.menu}
        style={{ left: x, top: y, width: WIDTH }}
        role="menu"
        onContextMenu={swallow()}
      >
        {items.map((entry, index) => (
          <div key={index} className={entry.separated ? styles.grouped : undefined}>
            {entry.kind === 'panel' ? (
              <div className={styles.panel}>{entry.render(onClose)}</div>
            ) : entry.kind === 'submenu' ? (
              <button
                type="button"
                role="menuitem"
                aria-haspopup="menu"
                className={styles.item}
                onMouseEnter={(event) => openSub(event.currentTarget.getBoundingClientRect(), entry)}
                onClick={(event) => openSub(event.currentTarget.getBoundingClientRect(), entry)}
              >
                <span className={styles.itemIcon}>
                  {entry.icon ? <Icon name={entry.icon} size={13} /> : null}
                </span>
                {entry.label}
                <span className={styles.itemArrow}>
                  <Icon name="chev" size={12} />
                </span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                className={`${styles.item} ${entry.danger ? styles.itemDanger : ''}`}
                onMouseEnter={() => setSub(null)}
                onClick={() => {
                  onClose();
                  entry.onSelect();
                }}
              >
                <span className={styles.itemIcon}>
                  {entry.icon ? <Icon name={entry.icon} size={13} /> : null}
                </span>
                {entry.label}
                {entry.hint ? <span className={styles.itemHint}>{entry.hint}</span> : null}
              </button>
            )}
          </div>
        ))}
      </div>

      {sub ? <Panel items={sub.items} x={sub.x} y={sub.y} onClose={onClose} /> : null}
    </>
  );
}
