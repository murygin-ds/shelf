import { useEffect } from 'react';

import { Icon, ICON_NAMES, type IconName } from '@/ui/Icon';
import { below } from '@/ui/position';

import styles from './sidebar.module.css';

export interface PickerTarget {
  x: number;
  y: number;
  current: string | undefined;
  onPick: (icon: string | undefined) => void;
}

const SIZE = { width: 254, height: 200 };

/** Positions the popover so it never leaves the viewport, the way the design opens it. */
export function pickerPosition(anchor: DOMRect): { x: number; y: number } {
  return below(anchor, SIZE);
}

export function IconPicker({ target, onClose }: { target: PickerTarget; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} />
      <div className={styles.picker} style={{ left: target.x, top: target.y }}>
        <div className={styles.pickerHead}>
          <span className="label">ICON</span>
          <button
            type="button"
            className={styles.pickerReset}
            onClick={() => {
              target.onPick(undefined);
              onClose();
            }}
          >
            Reset
          </button>
        </div>

        <div className={styles.pickerGrid}>
          {ICON_NAMES.map((name) => (
            <button
              key={name}
              type="button"
              title={name}
              className={`${styles.pickerCell} ${target.current === name ? styles.pickerCellOn : ''}`}
              onClick={() => {
                target.onPick(name);
                onClose();
              }}
            >
              <Icon name={name as IconName} size={15} />
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
