import { type MouseEvent, type ReactElement, useCallback, useEffect, useState } from 'react';

import { Icon, type IconName } from './Icon';
import { clampToViewport } from './position';
import styles from './contextmenu.module.css';

export interface MenuItem {
  label: string;
  icon?: IconName;
  onSelect: () => void;
  /** Destructive actions read differently and sit behind a separator. */
  danger?: boolean;
  separated?: boolean;
}

interface Request {
  x: number;
  y: number;
  items: MenuItem[];
}

const ITEM_H = 30;
const PADDING = 12;
const WIDTH = 200;

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
  open: (event: MouseEvent, items: MenuItem[]) => void;
  menu: ReactElement | null;
} {
  const [request, setRequest] = useState<Request | null>(null);

  const open = useCallback((event: MouseEvent, items: MenuItem[]) => {
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

  const height =
    request.items.length * ITEM_H +
    request.items.filter((item) => item.separated).length * 7 +
    PADDING;

  const { x, y } = clampToViewport(request.x, request.y, { width: WIDTH, height });

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} onContextMenu={(e) => e.preventDefault()} />

      <div className={styles.menu} style={{ left: x, top: y, width: WIDTH }} role="menu">
        {request.items.map((item) => (
          <div key={item.label} className={item.separated ? styles.grouped : undefined}>
            <button
              type="button"
              role="menuitem"
              className={`${styles.item} ${item.danger ? styles.itemDanger : ''}`}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
            >
              <span className={styles.itemIcon}>
                {item.icon ? <Icon name={item.icon} size={13} /> : null}
              </span>
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}
