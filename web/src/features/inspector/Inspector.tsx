import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import * as collab from '@/api/collab';
import { describe } from '@/api/errors';
import * as graphApi from '@/api/graph';
import * as revisionsApi from '@/api/revisions';
import * as shareApi from '@/api/share';
import type { NoteNode } from '@/api/workspace';
import { revealLine, topLine, watchTopLine } from '@/features/editor/reveal';
import { format, m } from '@/i18n';
import { headingAt, outline } from '@/lib/outline';
import { allTags, extractTags, normalizeTag } from '@/lib/search';
import { resolvables, resolveWikilinks } from '@/lib/wikilinks';
import { usePrefs } from '@/store/prefs';
import { useWorkspace } from '@/store/workspace';
import { Icon } from '@/ui/Icon';

import styles from './inspector.module.css';

type Tab = 'outline' | 'links' | 'tags' | 'history' | 'share';

// The map comes first and opens by default: it is the one panel that says something about
// the note being read rather than about the note as an object.
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'outline', label: m.inspector.tabs.outline },
  { id: 'links', label: m.inspector.tabs.links },
  { id: 'tags', label: m.inspector.tabs.tags },
  { id: 'history', label: m.inspector.tabs.history },
  { id: 'share', label: m.inspector.tabs.share },
];

export function Inspector({ note }: { note: NoteNode }) {
  const [tab, setTab] = useState<Tab>('outline');

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
        {tab === 'outline' ? <Outline note={note} /> : null}
        {tab === 'links' ? <Links note={note} /> : null}
        {tab === 'tags' ? <Tags note={note} /> : null}
        {tab === 'history' ? <History note={note} /> : null}
        {tab === 'share' ? <Share note={note} /> : null}
      </div>
    </div>
  );
}

/**
 * The note's own headings, as a map to steer by.
 *
 * Taken from the open body rather than from the index, for the reason the tags panel is: a
 * heading just typed has to appear under the caret that typed it rather than one poll later.
 * The marked entry is the section at the top of the viewport, so the map follows the note as
 * it is scrolled rather than staying where the caret was left.
 */
function Outline({ note }: { note: NoteNode }) {
  const { open } = useWorkspace();
  const line = useSyncExternalStore(watchTopLine, topLine);

  const body = open?.note.id === note.id ? open.body : '';
  const headings = useMemo(() => outline(body), [body]);
  const here = headingAt(headings, line);

  if (open?.locked) {
    return <p className={styles.empty}>{m.inspector.outline.locked}</p>;
  }

  return (
    <>
      <p className={styles.section}>{m.inspector.outline.section(headings.length)}</p>

      {headings.length === 0 ? (
        <p className={styles.empty}>{m.inspector.outline.empty}</p>
      ) : (
        headings.map((heading, index) => (
          <button
            key={heading.line}
            type="button"
            data-level={heading.level}
            className={`${styles.head} ${index === here ? styles.headHere : ''}`}
            // Indented by ancestry: the level decides the size, the depth decides the step.
            style={{ paddingLeft: 9 + heading.depth * 12 }}
            aria-current={index === here || undefined}
            onClick={() => revealLine(heading.line)}
          >
            {heading.text}
          </button>
        ))
      )}
    </>
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
  const { resolved, unresolved } = resolveWikilinks(
    body,
    resolvables(tree.folders, tree.notes),
    note.id,
  );

  return (
    <>
      <p className={styles.section}>{m.inspector.links.backlinks(found?.links.length ?? 0)}</p>

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
        <p className={styles.empty}>{m.inspector.links.empty}</p>
      )}

      {found && found.hidden > 0 ? (
        <div className={styles.hidden}>{m.inspector.links.hidden(found.hidden)}</div>
      ) : null}

      {resolved.length ? (
        <>
          <p className={styles.section} style={{ marginTop: 16 }}>
            {m.inspector.links.out(resolved.length)}
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
          {m.inspector.links.unresolved(unresolved.length)}{' '}
          {unresolved.slice(0, 3).map((title) => `[[${title}]]`).join(', ')}
          {unresolved.length > 3 ? '…' : '.'} {m.inspector.links.unresolvedTail}
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
  const frozen = usePrefs((state) => state.readOnly);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const readOnly = frozen || note.permission === 'view' || note.permission === 'comment';
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
      <p className={styles.section}>{m.inspector.tags.section(note.tags.length)}</p>

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
                  aria-label={m.inspector.tags.remove(tag)}
                  onClick={() => void remove(tag)}
                >
                  <Icon name="x" size={10} />
                </button>
              )}
            </span>
          ))}
        </div>
      ) : (
        <p className={styles.empty}>{m.inspector.tags.empty}</p>
      )}

      {readOnly ? null : (
        <>
          <input
            className={styles.input}
            value={draft}
            list="shelf-tag-suggestions"
            placeholder={m.inspector.tags.add}
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
            {m.inspector.tags.inText(inline.length)}
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
          <div className={styles.hidden}>{m.inspector.tags.inTextNote}</div>
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
      <p className={styles.section}>{m.inspector.history.section(list.length)}</p>

      {error ? <div className={styles.error}>{error}</div> : null}

      {list.length === 0 ? (
        <p className={styles.empty}>{m.inspector.history.empty}</p>
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
              {revision.authorName || m.inspector.history.removedAuthor}
            </span>
            <span className={styles.itemMeta}>{format.recent(revision.createdAt)}</span>
          </button>
        ))
      )}

      {open ? (
        <>
          <p className={styles.section} style={{ marginTop: 16 }}>
            {m.inspector.history.version(open.contentSeq)}{' '}
            <Verdict authorship={open.authorship} />
          </p>
          <div className={styles.preview}>
            {open.locked ? m.inspector.history.locked : open.body}
          </div>
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
      return (
        <span className={`${styles.badge} ${styles.badgeOk}`}>
          {m.inspector.history.signatureOk}
        </span>
      );
    case 'invalid':
      return (
        <span className={`${styles.badge} ${styles.badgeBad}`}>
          {m.inspector.history.signatureBad}
        </span>
      );
    case 'unknown-author':
      return (
        <span className={`${styles.badge} ${styles.badgeWarn}`}>
          {m.inspector.history.authorUnknown}
        </span>
      );
    default:
      return (
        <span className={`${styles.badge} ${styles.badgeWarn}`}>{m.inspector.history.unsigned}</span>
      );
  }
}

function Share({ note }: { note: NoteNode }) {
  const { open } = useWorkspace();
  const frozen = usePrefs((state) => state.readOnly);
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
    if (!body || frozen) return;

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
    if (frozen) return;

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
    return <p className={styles.empty}>{m.inspector.share.denied}</p>;
  }

  return (
    <>
      <p className={styles.section}>
        {m.inspector.share.section(links.filter((link) => link.live).length)}
      </p>

      <p className={styles.empty}>{m.inspector.share.lede}</p>

      {error ? <div className={styles.error}>{error}</div> : null}

      {/* Publishing and revoking both write, so read-only leaves the list and takes the
          verbs. A link that is already live stays live: turning a switch on here does not
          reach out and close what other people are reading. */}
      {frozen ? (
        <div className={styles.hidden}>{m.inspector.share.frozen}</div>
      ) : (
        <button
          type="button"
          className={styles.action}
          disabled={busy || !body}
          onClick={() => void publish()}
        >
          {m.inspector.share.publish}
        </button>
      )}

      {created ? (
        <>
          <p className={styles.section} style={{ marginTop: 14 }}>
            {m.inspector.share.shownOnce}
          </p>
          <div className={styles.link}>{created}</div>
          <button
            type="button"
            className={styles.action}
            onClick={() => void navigator.clipboard?.writeText(created)}
          >
            {m.inspector.share.copy}
          </button>
        </>
      ) : null}

      {links.map((link) => (
        <div key={link.id} className={styles.item} style={{ cursor: 'default' }}>
          <span className={styles.itemMain}>
            {link.live
              ? m.inspector.share.live
              : link.revoked_at
                ? m.inspector.share.revoked
                : m.inspector.share.expired}{' '}
            · {m.inspector.share.views(link.view_count)}
          </span>
          {link.live && !frozen ? (
            <button
              type="button"
              className={`${styles.itemMeta} ${styles.revoke}`}
              disabled={busy}
              onClick={() => void revoke(link.id)}
            >
              {m.inspector.share.revoke}
            </button>
          ) : (
            <span className={styles.itemMeta}>{format.recent(link.created_at)}</span>
          )}
        </div>
      ))}
    </>
  );
}

