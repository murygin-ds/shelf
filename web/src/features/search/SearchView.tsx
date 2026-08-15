import { useMemo, useState } from 'react';

import { allTags, search } from '@/lib/search';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './search.module.css';

export function SearchView() {
  const { index, query, coverage, tree, setQuery, openNote } = useWorkspace();
  const [tag, setTag] = useState<string | null>(null);

  const tags = useMemo(() => allTags(index).slice(0, 8), [index]);
  const hits = useMemo(
    () => search(index, query, tag ? { tag } : {}),
    [index, query, tag],
  );

  const partial = coverage.covered < coverage.total;

  return (
    <div className={styles.view}>
      <div className={styles.inner}>
        <div className={styles.headline}>
          <Icon name="search" size={19} style={{ color: 'var(--text-quiet)' }} />
          <input
            className={styles.input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search this vault"
            autoFocus
            spellCheck={false}
          />
          <span className={styles.caret} />
          <span className={styles.count}>
            {query ? `${hits.length} RESULT${hits.length === 1 ? '' : 'S'}` : `${index.length} INDEXED`}
          </span>
        </div>

        {tags.length ? (
          <div className={styles.facets}>
            <button
              type="button"
              className={`${styles.facet} ${tag === null ? styles.facetOn : ''}`}
              onClick={() => setTag(null)}
            >
              All notes
            </button>
            {tags.map((name) => (
              <button
                key={name}
                type="button"
                className={`${styles.facet} ${tag === name ? styles.facetOn : ''}`}
                onClick={() => setTag(tag === name ? null : name)}
              >
                tag: #{name}
              </button>
            ))}
          </div>
        ) : null}

        <div className={styles.local}>
          <Icon name="key" size={12} />
          SEARCHED LOCALLY ON THE DECRYPTED INDEX — NO QUERY LEAVES THIS DEVICE
          {/* The promise above only holds for notes whose bodies are actually cached, so
              a partial index says so instead of quietly returning fewer results. */}
          {partial ? (
            <span className={styles.coverageWarn}>
              · INDEX {coverage.covered}/{coverage.total} — STILL DOWNLOADING
            </span>
          ) : null}
        </div>

        <div className={styles.results}>
          {hits.map((hit) => (
            <button
              key={hit.note.id}
              type="button"
              className={styles.hit}
              onClick={() => {
                const note = tree.notes.find((candidate) => candidate.id === hit.note.id);
                if (note) void openNote(note);
              }}
            >
              <span className={styles.hitHead}>
                <Icon name="doc" size={14} style={{ color: 'var(--text-quiet)' }} />
                <span className={styles.hitTitle}>{hit.note.title}</span>
                <span className={styles.hitPath}>{hit.note.path}</span>
                <span className={styles.hitWhen}>{stamp(hit.note.updatedAt)}</span>
              </span>
              <span className={styles.hitSnippet}>
                {hit.snippet.before}
                <mark className={styles.mark}>{hit.snippet.match}</mark>
                {hit.snippet.after}
              </span>
            </button>
          ))}

          {query && hits.length === 0 ? (
            <p className={styles.none}>
              Nothing matched. {partial ? 'The index is still filling in — try again in a moment.' : ''}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function stamp(iso: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));

  if (seconds < 60) return 'JUST NOW';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M AGO`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}H AGO`;

  return `${Math.floor(seconds / 86400)}D AGO`;
}
