import { useState } from 'react';

import { m } from '@/i18n';

import styles from './tablegrid.module.css';

const MAX_ROWS = 6;
const MAX_COLS = 6;
const CELL = 16;
const GAP = 3;

/** What the menu has to reserve for this, since it is placed before React draws it. */
export const GRID_HEIGHT = MAX_ROWS * (CELL + GAP) + 24;

/**
 * Pick a table by dragging across a grid, the way every office suite has done it for thirty
 * years. The count under the grid is the point: `3 × 4` is unambiguous where a hovered
 * rectangle alone is not.
 */
export function TableGrid({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [over, setOver] = useState<{ rows: number; cols: number } | null>(null);

  return (
    <div className={styles.grid} onMouseLeave={() => setOver(null)}>
      <div className={styles.cells} style={{ gridTemplateColumns: `repeat(${MAX_COLS}, ${CELL}px)` }}>
        {Array.from({ length: MAX_ROWS * MAX_COLS }, (_, index) => {
          const row = Math.floor(index / MAX_COLS) + 1;
          const col = (index % MAX_COLS) + 1;
          const on = over !== null && row <= over.rows && col <= over.cols;

          return (
            <button
              key={index}
              type="button"
              className={`${styles.cell} ${on ? styles.cellOn : ''}`}
              style={{ width: CELL, height: CELL }}
              onMouseEnter={() => setOver({ rows: row, cols: col })}
              onClick={() => onPick(row, col)}
              aria-label={m.editor.grid.size(row, col)}
            />
          );
        })}
      </div>

      <div className={styles.size}>{over ? `${over.rows} × ${over.cols}` : m.editor.grid.empty}</div>
    </div>
  );
}
