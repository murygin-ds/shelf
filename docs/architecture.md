# Architecture

[← README](../README.md) ·
[Architecture](architecture.md) ·
[Security](security.md) ·
[Connector](mcp.md) ·
[Deployment](deploy.md) ·
[API](api.md)

---

## Layers

```
cmd/server → internal/app (dependency wiring, graceful shutdown)
  internal/api            gin: root router, SPA fallback, health, error format
    middleware/           request id, logging, recovery, CORS, body limit, auth, deadline
    v1/{auth,vault,access,realtime,mcp}/   handlers and DTOs, wired in internal/api/v1/router.go
  internal/vault          the domain: permissions, key scopes, sync, re-key, graph, revisions
  internal/access         members, grants, groups, invites
  internal/realtime       the live editing hub: connections, rooms, frames
  internal/storage/postgres   pgxpool repositories, including the permission CTE in sql.go
  internal/web            go:embed of the built SPA
```

`internal/vault` and `internal/access` contain neither SQL nor HTTP: they take narrow
repository interfaces (`Repository`, `SyncRepository`, `GraphRepository`, …) that one
Postgres `workspace` repository satisfies in full. Domain sentinel errors (`vault.ErrNotFound`,
`ErrVersionConflict`, `ErrScopeMismatch`, …) are turned into response codes in
[internal/api/errors.go](../internal/api/errors.go) — the domain returns those rather than
anything HTTP-shaped.

One piece of wiring in [internal/api/v1/router.go](../internal/api/v1/router.go) is not
obvious: the realtime hub is created *before* the repositories, so that they can announce
commits to it, and is handed to them as a `postgres.Announcer`. A nil announcer means the
socket is off and clients simply keep polling. `Router.Close()` exists because
`http.Server.Shutdown` neither closes hijacked websocket connections nor waits for them — it
has to be called before `Shutdown`.

## Layout

```
cmd/server/            entry point, swagger annotations of the general information
internal/
  app/                 dependency wiring, startup and graceful shutdown
  api/                 root router, health probes, SPA fallback, error format
    middleware/         request id, logging, recovery, CORS, body limit, auth, rate limit
    request/            binding, id and If-Match helpers
    response/           response and error helpers
    v1/{auth,vault,access,realtime,mcp}/   handlers and DTOs per feature
  auth/                registration, login, sessions, tokens, Argon2id
  vault/               the domain: permissions, scopes, sync, re-key, graph, revisions,
                       sharing, audit. No SQL and no HTTP.
    accesscases/        the permission truth table both implementations are held to
  access/              members, grants, invites
  mcp/                 the Claude connector: its account, its keyring, the tools it exposes
  envelope/            the sealing web/src/crypto does, repeated here for the connector
  realtime/            the live editing socket: hub, connections, rooms, frames
  config/ logger/ ratelimit/
  storage/postgres/    pgxpool and the repositories, including the permission CTE
  web/                 go:embed of the built frontend
web/src/
  crypto/              kdf, aead, sealed box, identity, keyring, envelope, signatures
  api/                 one module per resource; every []byte field typed as base64
  db/                  IndexedDB cache — ciphertext only
  sync/                delta pull, hydration, the local search index, the live socket
  collab/              the shared document: room, carets, per-person colours
  store/               zustand: session and workspace
  lib/                 wikilink resolution, the search index, the heading outline,
                       passphrase strength, the archive format and the zip it travels in
  ui/                  icons and the shared primitives
  styles/              the design tokens everything else reads
  features/            auth, shell, sidebar, editor, search, graph, inspector, access, share,
                       transfer, claude
configs/               config.yaml
deploy/Caddyfile       the proxy in front of a server install
compose.prod.yml       the production topology: Postgres, the service, Caddy
install.sh             one command that puts all three on a fresh machine
migrations/            golang-migrate SQL migrations, embedded and applied at startup
testdata/              the crypto vectors both implementations are held to
docs/                  generated swagger specification
```

## The client

The frontend is not a view over the API — it is where the data exists in the clear, so a
few of its choices are load-bearing.

**IndexedDB holds ciphertext, never plaintext.** The decrypted search index lives in memory
and dies with the tab. That is what makes the lock state mean something, and what keeps a
stolen browser profile no worse than a stolen database dump. The cost is that search is
only as complete as the index is warm, so the status bar shows coverage (`INDEX 12/213`)
rather than letting an incomplete answer look complete.

**A reload skips the passphrase, a new tab does not.** The master key is wrapped with an AES
key generated non-extractable and parked in a database of its own (`shelf-unlock`), while
the permission to use that wrap is a marker in `sessionStorage` — so it dies with the tab
that wrote it, and the key is resumable for exactly as long as the tab that was already
holding it in memory. Twelve hours bound the one case that stretches that: a browser told to
restore its tabs restores their `sessionStorage` along with them. Signing out, locking by
hand, changing the passphrase and a refresh the server rejects all delete the record, and a
fresh session only starts writing one once the recovery kit is acknowledged, so no resume
can walk past a code that was never shown.

**A write that meets no network is queued, not lost.** The body is sealed first, so what
waits in IndexedDB is ciphertext like everything else there, and one entry per note — a body
write replaces the whole body, so only the newest attempt is worth keeping. It goes out on
reconnect, on the next visible tick, and when the vault is opened again. A conflict during
that replay is dropped rather than retried forever: nobody but a client can merge two
ciphertexts, and a queued copy that will be refused every time is not a copy worth keeping.

**A missing key is a state, not an error.** `decryptMeta` returns a locked marker instead of
throwing, which is why greyed rows in the tree and `••••••` in the graph fall out naturally
rather than through a try/catch in forty places.

**The graph is laid out in the tab, and the tab decides what is on screen.** Every note in
the vault comes back as a node — `note_links` has no say in which notes exist — so most of an
ordinary vault is dots nothing points at. Those are left out by default, counted in the
legend and switched back on from the header. What remains settles under a force simulation
on an unbounded plane, and a viewport transform decides which part of it the panel shows;
both are pure functions with tests (`features/graph/layout.ts`, `viewport.ts`), because the
component around them owns an animation loop, a pointer and a `ResizeObserver` and can only
be looked at. Positions, that transform and the hover highlight are written straight onto
the SVG rather than through React state — at a thousand notes a re-render per frame is the
difference between sixty frames a second and a slideshow — and the loop stops when the graph
comes to rest. Nothing about the arrangement is stored: a note pinned by hand stays where it
was put until the view is left.

**Writes carry an optimistic lock.** `PUT /files/{id}/content` takes `If-Match:
<content_seq>` and also names the key version it sealed under — a re-key moves the row to a
new key without touching that sequence, so a write held up across a rotation has to be
refused rather than accepted and relabelled.

**Every body is signed.** `view`, `comment` and `edit` are the same key, so without a
signature any reader could produce ciphertext that decrypts and no reader could tell. The
signature covers the slot as well as the bytes, and the reader checks the author's key
against the member list it already holds rather than against whatever arrived with the
revision.

**Read-only mode is a property of the browser, not of the account.** The switch in the
account menu (`store/prefs.ts`, remembered in `localStorage`) stops this device writing to
any vault — bodies, the tree, tags and icons, the trash, members, grants, groups, invites,
public links, re-keys, and creating or importing a vault. The shell drops those verbs so
they cannot be reached, and every one of them is refused again in the workspace store, which
is where a stale timer or a keyboard shortcut would otherwise land. Inside the body two
things do not follow from `EditorView.editable` and are switched off by hand: a table cell is
a `contenteditable` of its own inside the editor's, so the grid carries the mode in its
widget and rebuilds when it changes; and Cut and Paste in the right-click menu dispatch
changes directly rather than through a command that consults `EditorState.readOnly`, so they
are taken out of the menu instead. Two further consequences are
worth stating: a note opened in this mode joins no live editing session at all, because the
server names the longest-standing member who may write as the committer and a tab holding
that job without writing would strand everybody else's edits in the document; and a body
queued offline before the mode went on stays queued until it goes off. It is a guard rail
for the person at the keyboard rather than a permission — the account keeps every role it
had, and another tab or device writes as before. Somebody who must not write is given `view`.

### Export and import

A vault leaves as a plain zip — `notes/…/<name>.md` in the folder shape the sidebar shows,
plus a `shelf.json` — and comes back as a **new** vault. Both run entirely in the browser for
the usual reason: the server holds ciphertext, so nobody else can build the archive or read it
back. The dialog says the archive is not encrypted, because from the moment it lands in the
downloads folder it is exactly as protected as the disk under it.

Two rules make the round trip exact. `shelf.json` is authoritative — names, icons, tags and the
tree are read from it, never inferred from the paths, which frees a path to be mangled into
whatever a file system accepts. And a `.md` file holds the body and nothing else: front matter
would have to be stripped on the way back, and that step eats a note that legitimately starts
with `---`.

What does not survive is what belongs to the vault rather than to the text: revision history
and its signatures, members, grants and groups, folders that had a key of their own, and the
ids themselves. Nothing in an archive is reused as an id on import — the additional data binds
every ciphertext to its slot, and these slots are new. A node the reader holds no key for is
left out rather than guessed at, and the report says how many.

## Live editing

Two people in one note do not take turns. Their edits merge, each sees the other's caret
and selection with a name on it, and the note header says who else is here.

The merge happens in the browsers. A server that cannot read the text cannot transform one
edit against another, so the operational transform every collaborative editor is built on
is simply unavailable — what runs instead is a CRDT, and what the server does is relay
sealed updates and refuse the ones from somebody who may not write.

**Updates are sealed and signed like bodies.** A batch of keystrokes is encrypted under the
note's scope key and signed with the author's ECDSA key, and a reader checks the signature
*before* merging. Refusing a reader's frames on the socket is the server behaving itself;
the signature is what holds when it does not — `view`, `comment` and `edit` are one key, so
without it any reader could produce text that decrypts for everybody.

**One client writes the body back.** The document is the truth while a session is live, but
`files.content` is what search, revisions, public links and offline reading are built on. So
the server names a committer — the longest standing connection that may write — and it
commits the folded document two seconds after the room falls quiet, and at least every
fifteen. The server cannot do this itself for the usual reason, which is why the body lags
the document between commits.

**A body written around the document invalidates it.** An offline write replayed from the
outbox, a tab too old to speak the socket, a re-key: each moves the text out from under the
session, so the document's epoch rises, its log is dropped, and the open tabs are told to
start again from what was just written. Unsent local edits do not survive that, and the
conflict banner says so rather than letting a sentence disappear quietly.

**What an invalidation leaves behind is not a document.** The row stays — the epoch has to go
on rising, or an update still in flight against the replaced document would merge into its
successor — but it holds no snapshot and no log, and the server answers a note in that state
the way it answers one nobody has ever opened: no document here, seed one. The epoch travels
in that answer, because it is inside the AAD of the snapshot the client seals, and a seed
sealed under any other number would store something nobody can open. Handing the empty row
over as a document instead is what would turn a write from outside the session into a lost
note: the room adopts an empty text and the committer writes that emptiness back over the
body that replaced it.

**Carets are encrypted, names are not.** Where somebody's caret is gives away the length of
the document and the place they are working in, so it travels sealed under the same key as
the text. Who is in the room does not: the server already holds the membership and the
display names, and it states them itself — which also means the list is trustworthy rather
than whatever a client claims to be.

The socket is an accelerator, never the only channel. Polling continues at a slower cadence
while it is up, so a hub that dies costs latency and nothing else. `realtime.enabled: false`
turns the whole thing off and leaves the app exactly as it was.

## Development

```bash
make web        # build the frontend into internal/web/dist
make web-dev    # Vite dev server, proxying /api to :8080
make swagger    # regenerate docs/ after changing the annotations
make check      # fmt + vet + lint + tests
make tools      # install swag, migrate, golangci-lint
```

The tests that need a real database are behind a build tag and skip without a DSN:

```bash
make test-integration dsn="postgres://user@localhost:5432/shelf_test?sslmode=disable"
```

They drop and recreate the schema, so point them at a throwaway database. They are where
the permission CTE, the SQL functions behind it, and the reversibility of every migration
are actually checked.

## Known limits

Stated plainly, because each of them is a decision rather than an oversight:

- **A 409 conflict is resolved by choosing, not by merging.** The three choices are: take
  the server's version, keep yours as a new note, or copy it out. Nobody but a client can
  merge two ciphertexts, and a three-way merge of encrypted markdown is a feature of its own.
- **Revision history stays under the key it was written with.** Giving a folder its own key
  re-encrypts the current rows, not the archive — the same limit as "rotation cannot un-read
  what was already read".
- **Links go stale when a note moves.** A link is stored as a pair of ids, resolved from the
  text that was there when the note was last written. Renaming or moving the target leaves
  the edge pointing where it always did, while the body now names a path nothing carries.
  The next write of either note settles it; nothing sweeps the vault to do it sooner.
- **Read-only mode does not stop the connector.** It is a promise about one browser — the
  account keeps every role it had, and another tab, another device or a connector are all
  unaffected by it. Pausing Claude is a different thing from putting a tab in read-only, and
  it is done by revoking the connector's credentials.
- **Search through the connector opens every note in the vault.** The index a browser keeps
  lives in a tab this server cannot reach, so there is nothing else to search. It is bounded
  by the size of one vault and by the result limit, and it is the one operation here whose
  cost grows with the vault rather than with the request.
