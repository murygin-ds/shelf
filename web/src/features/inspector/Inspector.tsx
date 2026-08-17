import { useEffect, useState } from 'react';

import { ApiError } from '@/api/client';
import * as collab from '@/api/collab';
import * as graphApi from '@/api/graph';
import * as revisionsApi from '@/api/revisions';
import * as shareApi from '@/api/share';
import type { NoteNode } from '@/api/workspace';
import { allTags, extractTags, normalizeTag } from '@/lib/search';
import { resolveWikilinks } from '@/lib/wikilinks';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './inspector.module.css';

type Tab = 'links' | 'tags' | 'history' | 'share';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'links', label: 'LINKS' },
  { id: 'tags', label: 'TAGS' },
  { id: 'history', label: 'HISTORY' },
  { id: 'share', label: 'SHARE' },
];

export function Inspector({ note }: { note: NoteNode }) {
  const [tab, setTab] = useState<Tab>('links');

  return (
    <div className={styles.pane}>
      <div className={styles.tabs}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`${styles.tab} ${tab === entry.id ? styles.tabActive : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <div className={styles.body}>
        {tab === 'links' ? <Links note={note} /> : null}
        {tab === 'tags' ? <Tags note={note} /> : null}
        {tab === 'history' ? <History note={note} /> : null}
        {tab === 'share' ? <Share note={note} /> : null}
      </div>
    </div>
  );
}

function Links({ note }: { note: NoteNode }) {
  const { keyring, tree, open, openNote } = useWorkspace();
  const [found, setFound] = useState<graphApi.Backlinks | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!keyring) return;

    let live = true;

    // Every panel here is reused across notes rather than remounted, so each fetch has to
    // disown itself when the note changes. Without it a slow answer for the previous note
    // lands on the current one.
    setFound(null);
    setError(null);

    graphApi
      .backlinks(note.id, keyring)
      .then((next) => {
        if (live) setFound(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });

    return () => {
      live = false;
    };
  }, [note.id, keyring]);

  // Outgoing links come from the open body rather than from the server: they are resolved
  // here in the first place, and showing the server's copy would lag a keystroke behind.
  const body = open?.note.id === note.id ? open.body : '';
  const { resolved, unresolved } = resolveWikilinks(body, tree.notes, note.id);

  return (
    <>
      <p className={styles.section}>BACKLINKS · {found?.links.length ?? 0}</p>

      {error ? <div className={styles.error}>{error}</div> : null}

      {found?.links.length ? (
        found.links.map((link) => (
          <button
            key={link.id}
            type="button"
            className={styles.item}
            disabled={link.locked}
            onClick={() => {
              const target = tree.notes.find((candidate) => candidate.id === link.id);
              if (target) void openNote(target);
            }}
          >
            <Icon name="doc" size={12} style={{ flex: 'none', marginTop: 2 }} />
            <span className={styles.itemMain}>{link.name}</span>
          </button>
        ))
      ) : (
        <p className={styles.empty}>Nothing points here yet. Write [[a title]] in another note.</p>
      )}

      {found && found.hidden > 0 ? (
        <div className={styles.hidden}>
          {found.hidden} more note{found.hidden === 1 ? '' : 's'} link{found.hidden === 1 ? 's' : ''}{' '}
          here from somewhere you cannot see. The count is honest; the names are not yours to
          have.
        </div>
      ) : null}

      {resolved.length ? (
        <>
          <p className={styles.section} style={{ marginTop: 16 }}>
            LINKS OUT · {resolved.length}
          </p>
          {resolved.map((id) => {
            const target = tree.notes.find((candidate) => candidate.id === id);

            return target ? (
              <button
                key={id}
                type="button"
                className={styles.item}
                onClick={() => void openNote(target)}
              >
                <Icon name="doc" size={12} style={{ flex: 'none', marginTop: 2 }} />
                <span className={styles.itemMain}>{target.name}</span>
              </button>
            ) : null;
          })}
        </>
      ) : null}

      {unresolved.length ? (
        <div className={styles.hidden}>
          {unresolved.length} link{unresolved.length === 1 ? '' : 's'} in this note match
          nothing you can open: {unresolved.slice(0, 3).map((title) => `[[${title}]]`).join(', ')}
          {unresolved.length > 3 ? '…' : ''}. Unmatched titles stay on this device — sending
          them would publish the text.
        </div>
      ) : null}
    </>
  );
}

/**
 * The note's own tags.
 *
 * They live in the same encrypted meta as its name, so choosing one is a save rather than an
 * edit to the text — which is the whole difference from Obsidian, where a tag is a word you
 * remember to type. Tags written into the body still count, and are listed here as what they
 * are: part of the text, editable only there.
 */
function Tags({ note }: { note: NoteNode }) {
  const { open, index, setTags, setQuery } = useWorkspace();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const readOnly = note.permission === 'view' || note.permission === 'comment';
  const body = open?.note.id === note.id ? open.body : '';

  // From the body rather than from the index: the index is rebuilt on sync, and a tag just
  // typed would take eight seconds to show up under the caret that typed it.
  const inline = extractTags(body).filter((tag) => !note.tags.includes(tag));
  const suggestions = allTags(index).filter((tag) => !note.tags.includes(tag));

  const add = async (raw: string) => {
    const tag = normalizeTag(raw);
    if (!tag || note.tags.includes(tag)) {
      setDraft('');
      return;
    }

    setBusy(true);
    setDraft('');

    try {
      await setTags(note, [...note.tags, tag]);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (tag: string) => {
    setBusy(true);

    try {
      await setTags(note, note.tags.filter((candidate) => candidate !== tag));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className={styles.section}>TAGS · {note.tags.length}</p>

      {note.tags.length ? (
        <div className={styles.chips}>
          {note.tags.map((tag) => (
            <span key={tag} className={styles.chip}>
              <button type="button" className={styles.chipLabel} onClick={() => setQuery(`#${tag}`)}>
                #{tag}
              </button>
              {readOnly ? null : (
                <button
                  type="button"
                  className={styles.chipRemove}
                  disabled={busy}
                  aria-label={`Remove ${tag}`}
                  onClick={() => void remove(tag)}
                >
                  <Icon name="x" size={10} />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className={styles.empty}>
          No tags yet. They are sealed with the note’s name, so the server never sees them.
        </p>
      )}

      {readOnly ? null : (
        <>
          <input
            className={styles.input}
            value={draft}
            list="shelf-tag-suggestions"
            placeholder="Add a tag"
            spellCheck={false}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void add(draft);
              }
            }}
          />
          <datalist id="shelf-tag-suggestions">
            {suggestions.map((tag) => (
              <option key={tag} value={tag} />
            ))}
          </datalist>
        </>
      )}

      {inline.length ? (
        <>
          <p className={styles.section} style={{ marginTop: 16 }}>
            IN THE TEXT · {inline.length}
          </p>
          <div className={styles.chips}>
            {inline.map((tag) => (
              <span key={tag} className={`${styles.chip} ${styles.chipQuiet}`}>
                <button
                  type="button"
                  className={styles.chipLabel}
                  onClick={() => setQuery(`#${tag}`)}
                >
                  #{tag}
                </button>
              </span>
            ))}
          </div>
          <div className={styles.hidden}>
            These are written into the note itself. Edit the text to change them.
          </div>
        </>
      ) : null}
    </>
  );
}

function History({ note }: { note: NoteNode }) {
  const { vaultId, keyring } = useWorkspace();
  const [list, setList] = useState<revisionsApi.Revision[]>([]);
  const [open, setOpen] = useState<revisionsApi.RevisionBody | null>(null);
  const [roster, setRoster] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The roster is what turns the server's word into a check: the public key that verifies
  // a revision arrives in the same response as the name it is claimed for, so it is worth
  // nothing unless it matches the key this vault already knows for that member.
  useEffect(() => {
    if (vaultId === null) return;

    let live = true;

    collab
      .listMembers(vaultId)
      .then((data) => {
        if (live) setRoster(new Map(data.members.map((m) => [m.user_id, m.public_key])));
      })
      .catch(() => undefined);

    return () => {
      live = false;
    };
  }, [vaultId]);

  useEffect(() => {
    let live = true;

    setOpen(null);
    setList([]);
    setError(null);

    revisionsApi
      .listRevisions(note.id)
      .then((next) => {
        if (live) setList(next);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });

    return () => {
      live = false;
    };
  }, [note.id]);

  const show = async (revisionId: number) => {
    if (!keyring) return;

    setBusy(true);
    setError(null);

    try {
      setOpen(await revisionsApi.readRevision(note, revisionId, keyring, roster));
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className={styles.section}>VERSIONS · {list.length}</p>

      {error ? <div className={styles.error}>{error}</div> : null}

      {list.length === 0 ? (
        <p className={styles.empty}>No saved versions yet.</p>
      ) : (
        list.map((revision) => (
          <button
            key={revision.id}
            type="button"
            className={styles.item}
            disabled={busy}
            onClick={() => void show(revision.id)}
          >
            <span className={styles.itemMain}>
              {revision.authorName || 'a removed account'}
            </span>
            <span className={styles.itemMeta}>{when(revision.createdAt)}</span>
          </button>
        ))
      )}

      {open ? (
        <>
          <p className={styles.section} style={{ marginTop: 16 }}>
            VERSION {open.contentSeq} <Verdict authorship={open.authorship} />
          </p>
          <div className={styles.preview}>{open.locked ? 'You hold no key for this version.' : open.body}</div>
        </>
      ) : null}
    </>
  );
}

/**
 * Says what the signature proves. The three failures are deliberately distinct: unsigned
 * means nobody claimed authorship, unknown means the author's key is unreadable here, and
 * invalid means somebody wrote this under another person's name.
 */
function Verdict({ authorship }: { authorship: revisionsApi.RevisionBody['authorship'] }) {
  switch (authorship) {
    case 'valid':
      return <span className={`${styles.badge} ${styles.badgeOk}`}>SIGNATURE OK</span>;
    case 'invalid':
      return <span className={`${styles.badge} ${styles.badgeBad}`}>SIGNATURE FAILED</span>;
    case 'unknown-author':
      return <span className={`${styles.badge} ${styles.badgeWarn}`}>AUTHOR UNKNOWN</span>;
    default:
      return <span className={`${styles.badge} ${styles.badgeWarn}`}>UNSIGNED</span>;
  }
}

function Share({ note }: { note: NoteNode }) {
  const { open } = useWorkspace();
  const [links, setLinks] = useState<shareApi.ShareLinkDto[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canShare = note.permission === 'own';
  const body = open?.note.id === note.id ? open : null;

  const reload = async (fileId: number) => {
    try {
      setLinks((await shareApi.listShareLinks(fileId)).links);
    } catch (cause) {
      setError(describe(cause));
    }
  };

  useEffect(() => {
    // Cleared first: a REVOKE button still showing the previous note's links would close
    // a link the reader never meant to touch.
    setLinks([]);
    setCreated(null);
    setError(null);

    if (!canShare) return;

    let live = true;

    shareApi
      .listShareLinks(note.id)
      .then((data) => {
        if (live) setLinks(data.links);
      })
      .catch((cause: unknown) => {
        if (live) setError(describe(cause));
      });

    return () => {
      live = false;
    };
  }, [note.id, canShare]);

  const publish = async () => {
    if (!body) return;

    setBusy(true);
    setError(null);

    try {
      const link = await shareApi.createShareLink(note, body.body, body.contentSeq);
      setCreated(link.url);
      await reload(note.id);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (linkId: number) => {
    setBusy(true);
    setError(null);

    try {
      await shareApi.revokeShareLink(linkId);
      await reload(note.id);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!canShare) {
    return <p className={styles.empty}>Only somebody who can manage this note may publish it.</p>;
  }

  return (
    <>
      <p className={styles.section}>PUBLIC LINKS · {links.filter((link) => link.live).length}</p>

      <p className={styles.empty}>
        Anyone with the link reads a copy of this note as it is now. The secret lives in
        the part of the URL a browser never sends, so the server stores a digest and cannot
        open what it is serving — and the link carries only this note, never the key to the
        folder it sits in.
      </p>

      {error ? <div className={styles.error}>{error}</div> : null}

      <button
        type="button"
        className={styles.action}
        disabled={busy || !body}
        onClick={() => void publish()}
      >
        Publish this version
      </button>

      {created ? (
        <>
          <p className={styles.section} style={{ marginTop: 14 }}>
            SHOWN ONCE
          </p>
          <div className={styles.link}>{created}</div>
          <button
            type="button"
            className={styles.action}
            onClick={() => void navigator.clipboard?.writeText(created)}
          >
            Copy link
          </button>
        </>
      ) : null}

      {links.map((link) => (
        <div key={link.id} className={styles.item} style={{ cursor: 'default' }}>
          <span className={styles.itemMain}>
            {link.live ? 'Live' : link.revoked_at ? 'Revoked' : 'Expired'} ·{' '}
            {link.view_count} view{link.view_count === 1 ? '' : 's'}
          </span>
          {link.live ? (
            <button
              type="button"
              className={styles.itemMeta}
              style={{ border: 0, background: 'none', cursor: 'pointer' }}
              disabled={busy}
              onClick={() => void revoke(link.id)}
            >
              REVOKE
            </button>
          ) : (
            <span className={styles.itemMeta}>{when(link.created_at)}</span>
          )}
        </div>
      ))}
    </>
  );
}

function when(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h ago`;

  return new Date(iso).toLocaleDateString();
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message || `HTTP ${cause.status}`;
  if (cause instanceof Error) return cause.message || cause.name;

  return 'something went wrong';
}
