import { useEffect, useMemo, useState } from 'react';

import { search } from '@/lib/search';
import { useWorkspace } from '@/store/workspace';
import { useDismiss } from '@/ui/dismiss';
import { Icon } from '@/ui/Icon';

import styles from './palette.module.css';

const MAX_ROWS = 6;

/**
 * ⌘K over the same in-memory index the search view uses, so nothing typed here reaches
 * the server either.
 */
export function CommandPalette({ onClose }: { onClose: () => void }) {
  const { index, tree, openNote, setQuery, setView } = useWorkspace();
  const [term, setTerm] = useState('');
  const [cursor, setCursor] = useState(0);
  const dismiss = useDismiss(onClose);

  const hits = useMemo(() => search(index, term).slice(0, MAX_ROWS), [index, term]);

  useEffect(() => setCursor(0), [term]);

  const openAt = (position: number) => {
    const hit = hits[position];
    if (!hit) return;

    const note = tree.notes.find((candidate) => candidate.id === hit.note.id);
    if (note) void openNote(note);

    onClose();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setCursor((value) => Math.min(value + 1, Math.max(0, hits.length - 1)));
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setCursor((value) => Math.max(0, value - 1));
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, [hits.length, onClose]);

  return (
    <div className={styles.overlay} {...dismiss}>
      <div className={styles.panel}>
        <div className={styles.head}>
          <Icon name="search" size={16} style={{ color: 'var(--text-quiet)' }} />
          <input
            className={styles.input}
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                openAt(cursor);
              }
            }}
            placeholder="Find a note"
            autoFocus
            spellCheck={false}
          />
          <span className={styles.esc}>ESC</span>
        </div>

        <div className={styles.body}>
          <div className={styles.section}>NOTES</div>

          {hits.map((hit, position) => (
            <button
              key={hit.note.id}
              type="button"
              className={`${styles.row} ${position === cursor ? styles.rowOn : ''}`}
              onMouseEnter={() => setCursor(position)}
              onClick={() => openAt(position)}
            >
              <Icon name="doc" size={14} style={{ color: 'var(--text-quiet)' }} />
              <span className={styles.rowTitle}>{hit.note.title}</span>
              <span className={styles.rowPath}>{hit.note.path}</span>
            </button>
          ))}

          {term && hits.length === 0 ? <div className={styles.none}>No note matched.</div> : null}

          <div className={styles.section}>ACTIONS</div>
          <button
            type="button"
            className={styles.row}
            onClick={() => {
              setQuery(term);
              setView('search');
              onClose();
            }}
          >
            <Icon name="search" size={14} style={{ color: 'var(--text-quiet)' }} />
            <span className={styles.rowTitle}>Search everything for “{term || '…'}”</span>
          </button>
        </div>

        <div className={styles.footer}>
          <span>↑↓ NAVIGATE</span>
          <span>↵ OPEN</span>
          <span className={styles.footerSpacer} />
          <span>SEARCH IS LOCAL</span>
        </div>
      </div>
    </div>
  );
}
