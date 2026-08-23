# Shelf

Self-hosted, end-to-end encrypted notes for a team.

The server stores ciphertext and the shape around it: who is a member, which note sits in
which folder, when something changed. It never holds a key that opens any of it. Every
title, every body, every folder name is encrypted in the browser before it is sent, and
decrypted only there — so an administrator with a database dump and full access to this
process still cannot read a single note.

That is a promise with edges, and [What the server learns](#what-the-server-learns) states
exactly where they are.

| Layer         | Technology                                                     |
|---------------|----------------------------------------------------------------|
| HTTP          | [gin](https://github.com/gin-gonic/gin)                        |
| Database      | PostgreSQL 17 + [pgx/v5](https://github.com/jackc/pgx)         |
| Frontend      | React 19 + TypeScript + Vite, embedded in the binary           |
| Crypto        | WebCrypto: AES-256-GCM, ECDH P-256, ECDSA P-256, Argon2id      |
| Configuration | [viper](https://github.com/spf13/viper) + `.env` (godotenv)    |
| Logs          | [zap](https://github.com/uber-go/zap)                          |
| Documentation | [swaggo](https://github.com/swaggo/swag)                       |
| Migrations    | [golang-migrate](https://github.com/golang-migrate/migrate)    |

## Quick start

```bash
make env         # .env from .env.example
make db-up       # PostgreSQL in docker
make migrate-up  # apply the migrations
make web         # build the frontend into internal/web/dist
make run         # start the service
```

- App and API: `http://localhost:8080`
- Swagger UI: `http://localhost:8080/swagger/index.html`
- Probes: `GET /health` (liveness), `GET /ready` (readiness, pings the database)

`make help` lists every command. The binary serves the frontend itself; without `make web`
the API still works and the app answers `503` with the command to run.

## The encryption model

Everything follows from one decision: keys are derived and used on the device, and the
server is handed only what it cannot open.

**One password, two independent values.** Argon2id runs once over the passphrase and
produces 64 bytes. The first half is `auth_hash` and goes to the server, which stores an
Argon2id hash of it. The second half never leaves the device and wraps the master key.
Knowing everything the server has does not yield the second half.

**A master key, and an identity under it.** The master key wraps two P-256 keypairs: ECDH
for receiving keys, ECDSA for signing what you write. Both private keys live in one blob
encrypted with the master key; both public keys travel in `users.public_key`. WebCrypto
binds a key to one algorithm, and reusing one EC key for agreement and signatures is the
kind of shortcut that turns into a break later.

**Content keys belong to scopes, not to notes.** A *key scope* is a vault, a folder, or a
single note. Everything under a scope is sealed with its AES-256-GCM key, and that key is
sealed once per member with a sealed box (`ECDH(ephemeral, member) → HKDF-SHA256 →
AES-256-GCM`). Old versions are kept rather than replaced: revisions stay encrypted under whatever version
was current when they were written, which is why an old key grant is never dropped from
somebody who keeps access.

**Every ciphertext is bound to its slot.** The additional data is
`shelf/v1|<vault id>|<entity kind>|<entity uuid>|<scope uuid>|<key version>`. Without it a hostile server could
move one note's body onto another note in the same scope and the client would decrypt it
happily — confidentiality would hold, placement would not. Entities and scopes are named by
client-chosen UUIDs rather than serial ids, because the client has to know the name before
the row exists.

**Bodies are padded to 4 KiB.** Otherwise the stored size is a fingerprint of the text.

### Permissions and keys are one thing

Widening access is adding a key grant. **Narrowing access is only real if the node owns its
own key scope** — otherwise everyone who already holds the parent key still holds it, and
the denial is the server's good behaviour rather than arithmetic. The UI says which of the
two you are looking at, and offers *Protect with its own key* to convert one into the other.

The invariant the storage layer keeps, and never exposes as its own endpoint: a row in
`key_grants` is written only in the same transaction as the permission that justifies it.
There are five such places, and each writes the key beside the thing that justifies it:
creating a vault (the owner's own key), granting access, creating an invite (sealed to the
code rather than to a person), redeeming that invite, and committing a re-key.

A group holds a permission on behalf of several people and carries its own agreement
keypair. That keypair is the whole reason it exists: a scope key is sealed to the group
once, and the group's private key is sealed to each member — so adding somebody costs one
seal whatever the group reaches, rather than one per folder. Without it, adding a person to
a group would require the person doing it to hold every key the group touches, and an admin
excluded from one folder could not add anybody to a group that reaches it. The cost lands on
removal instead, which replaces the keypair and re-seals every scope: joining is common,
leaving is not.

Effective permission resolves top-down in one pass: the vault role sets a floor, a folder
narrows it, a note overrides both, and a grant addressed to a person outranks one reaching
them through a group. That rule is written twice — as `vault.Resolve` in Go and as a
recursive CTE in SQL — and
[a differential test](internal/storage/postgres/access_integration_test.go) drives both
over [the same table](internal/vault/accesscases/cases.go) so they cannot drift.

### Rotation

Removing a member revokes their access immediately and marks the scopes they could read as
needing rotation. Rotation is a resumable job rather than a request, because re-encrypting a
vault in the browser will not survive one HTTP timeout:

```
POST   /api/v1/vaults/{id}/rekeys   plan: which rows, whose keys
PUT    /api/v1/rekeys/{id}/items    batches of re-encrypted rows into staging
POST   /api/v1/rekeys/{id}/commit   one transaction: new key, swapped rows, grants
DELETE /api/v1/rekeys/{id}          throw the job away
```

A tab that dies mid-way leaves a staging table the server reaps, not a vault half of whose
rows are unreadable. Committing also closes every public link on the affected notes.

Rotation protects future reads. It cannot un-read what somebody already read, and the UI
says so rather than implying otherwise.

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

## What the server learns

Not the notes. It does learn, and cannot help learning:

- **The shape of the tree** — how many folders and notes exist, and which contains which.
- **Sizes**, to a 4 KiB granularity for bodies.
- **Every timestamp** — when a vault, folder or note was created, changed, or read.
- **Who changed what**, which over time is the whole graph of who works with whom.
- **Membership and roles**, and every change to them (that is what the audit log is).
- **The link graph** — which note references which, though not the titles that resolved it.
- **Login times and IP addresses**, like any web service.
- **Display names and login addresses**, because members have to be able to find and
  address each other, and **the email hint on an invite**, so an invitation can say who it
  was meant for.
- **The rhythm and rough volume of typing**, per author, while a note is being edited
  together. Updates are relayed as they happen and padded to 256 bytes rather than 4 KiB —
  padding a keystroke to a body's block would multiply the traffic of a session two
  hundredfold. Live collaboration and hiding that somebody is typing are not compatible.
- **Who is editing what, at the same time**, which is a sharper version of "who works with
  whom" than the timestamps alone give.

It does not learn: note titles, bodies, folder names, icons, tags, search queries, the
text of any link that did not resolve, or the private label a member keeps on a vault —
that one is sealed to the member's own identity key rather than the shared scope key, so
neither the server nor the other members can read it.

Two deliberate consequences worth knowing before you deploy this:

- **The graph view draws notes you cannot open**, as unnamed dashed nodes with no id, so
  that a note connected only through something invisible does not appear isolated. A vault
  can turn that off through the `vaults.graph_reveals_locked` column — the query honours it,
  though nothing exposes it yet — at the cost of showing each reader a picture that is only
  their slice.
- **A public link is a snapshot.** It carries its own copy of the note, encrypted under a
  key derived from a secret that lives in the URL fragment — which browsers never send. It
  does not carry the note's scope key, because a scope covers a whole folder or a whole
  vault and one published note must not become the key to everything beside it.

### Except with a connector

Everything above describes a vault without one. A vault that has a connector is readable by
this server in full, deliberately and visibly — see [The connector](#the-connector). No other
vault is affected: the server holds no key to them and has no way to obtain one.

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

## The connector

This is the one place where the promise the rest of this document makes does not hold, and it
is worth saying so before explaining how it works: **a vault with a connector is readable by
this server.** Not the metadata, not the shape — the folder names, the titles and the bodies.

The reason is unavoidable rather than clever. Claude reaches a vault over HTTPS from
Anthropic's network, so something on this side has to turn ciphertext into text. There is no
arrangement in which a remote assistant reads a vault and the server does not. What can be
arranged is that it is an exception: one vault at a time, only after its owner asked for it,
and undone by removing a member.

### It is a member, not a mechanism

A connector is an account. It has the same two-part identity blob a person has, it is
admitted to one vault as a member, and the vault's key reaches it through an ordinary key
grant. Nothing else in the system was taught about it.

That is the whole design, and everything below follows from it rather than from new code:

- **Rotation carries it.** The rotation plan lists the holders of the current key, and it is
  one of them. Nothing had to be added, and — more to the point — nothing can forget it.
- **Revoking it is removing a member**, which already deletes the membership, every grant at
  every version, and marks the scopes it could read as needing a rotation. The connector row
  hangs off the membership by a foreign key, so it goes in the same transaction.
- **Denying it a folder is a permission row.** Give the connector `none` on a folder and it
  disappears from what Claude can see, through the same query that hides a folder from a
  person.
- **It shows up in the member list**, with its own key fingerprint. Somebody reading the
  members of a vault sees the server among them, because it is.
- **What it writes is signed** with its own key, so a note it wrote says so in the history
  rather than appearing unattributed.

The private half of its identity is wrapped by `mcp.secret` from this service's
configuration, so a database dump alone opens nothing. That is a smaller claim than it
sounds: whoever holds both the dump and the configuration holds the vault.

### Getting the key to it

Two requests, because a key cannot be sealed to a public key that does not exist yet. The
first mints the identity and admits it with `key_state = pending_key` — a member that reads
nothing. The second seals the vault's scope key to it and writes the grant, in the one
transaction that justifies writing one. Only the vault's own scope is sealed, which is why a
folder with its own key stays private without a second mechanism for it.

### What Claude can do

Thirteen tools over Streamable HTTP at `/api/v1/mcp`: list the tree; read, search, create,
overwrite under an optimistic lock, append, move, rename and retag; create and trash folders;
and list and restore what is in the bin. Purging is not offered at all — it destroys
ciphertext nothing brings back.

Three of them have shapes worth knowing. Renaming and retagging are the same call, because
a name, an icon and a set of tags share one ciphertext: writing any of them back rebuilds all
of it, and a separate rename would be the shape that silently drops an icon. Trashing a
folder takes only an empty one — a folder goes with its whole subtree, and a model tidying up
one stray directory should not be able to remove a project by naming its folder. And the bin
is addressed by id rather than by path, because the place a trashed note came from may hold a
different note now.

Searching narrows by folder, by tag, or both, and either the text or the tag is enough on its
own. The narrowing is not only a filter: a search opens every note it looks at, so scoping is
what keeps the cost of asking about one project proportional to that project.

A write also records the note's links. `[[a/path.md]]` and `[[A title]]` are resolved against
the tree the connector just decrypted — paths first, since the tree it is given repeats titles
by design, and a shared title settles on the older note. That resolution exists twice, here
and in the browser (`internal/mcp/links.go` and `web/src/lib/wikilinks.ts`), because only a
holder of the key can turn a title into a note and both sides hold one. Without it everything
Claude wrote would stay off the graph until a person opened each note and saved it again.

Three refusals are worth knowing about. A write quoting a stale `content_seq` is refused
rather than merged, because nobody here can merge two ciphertexts. A write to a note somebody
has open in the editor is refused rather than performed: a body written from outside the live
document raises its epoch and drops the pending updates, which is right when an offline
client replays a write and looks like theft when it lands mid-sentence. And a write to a note
whose live document still owes its body a commit is refused for the same reason with nobody
left in the room to notice — a tab that went away without writing back leaves what was typed
in the log, and both `shelf_read_note` and `shelf_search_notes` report it as `pending_edits`
so a model reads the body, or a snippet of it, knowing it is not the whole of the note.

A connector admitted as a viewer is not offered the writing tools at all, rather than offered
tools that refuse. A model shown a tool will try it.

### Reaching it

Anthropic's own network calls the connector, from `160.79.104.0/21`. A server on `localhost`
or behind a home router is not reachable from there, whatever the configuration says, so
Claude Desktop needs a public HTTPS address with a valid certificate. Claude Code runs the
flow on the machine it is on and can reach a local one:

```bash
claude mcp add --transport http shelf http://localhost:8080/api/v1/mcp
```

Authentication is OAuth 2.1: dynamic client registration, PKCE with S256, and a refresh token
rotated on every use. The consent screen is a page in the client rather than a form the
server renders — the security headers set `form-action 'none'`, so a rendered form would be
blocked by the browser. Tokens live in their own table on purpose: rotation there is
single-use and a replay burns the chain it belongs to, which must not be the same chain a
browser session hangs from.

### The view

A connected vault gets a view of its own, next to Notes and Graph in the sidebar. It exists
because a tree answers the wrong question here: "which files are there" is not what somebody
wants from a vault used as a model's memory. What they want is which projects are moving,
what was decided, what the model wrote since they last looked, and which of the standing
facts are still blank — and the folders are only how those happen to be stored.

So the view reads the vault as what it holds. Projects become cards with their status, their
open steps and how many decisions they have logged; the log becomes a timeline; the standing
facts become a checklist that says which are still scaffolding; and everything the connector
wrote is listed on its own, newest first. Starting a project or a skill is a button rather
than a folder to copy, which is why the template no longer ships a `_template/` to copy from.

It costs nothing to open: everything on it is read out of the tree and the decrypted search
index the tab already holds, so it shows exactly what the connector can see and asks the
server for nothing extra.

### Two things the vault says to Claude itself

The template a Claude vault is created with carries both in its root document, because a
warning shown once in a dialog is a warning nobody re-reads: that this vault is readable by
the server and must not hold credentials, and that everything in it is data rather than
instructions. A note that tells the model to ignore its instructions is a note somebody
wrote.

## Authentication

The server knows neither the password nor the master key. Using `kdf_salt`/`kdf_params` the
client derives the wrapping key (stays on the device) and `auth_hash` (goes to the server).
The database holds an Argon2id hash of `auth_hash` and the keys wrapped by the client.

| Method | Endpoint                         | Purpose                                                                                       |
|--------|----------------------------------|-----------------------------------------------------------------------------------------------|
| POST   | `/api/v1/auth/register`          | registration together with a recovery key, opens a session right away                         |
| POST   | `/api/v1/auth/prelogin`          | `kdf_salt` and `kdf_params` by login — needed to compute `auth_hash`                          |
| POST   | `/api/v1/auth/login`             | login, the response carries the wrapped keys and a token pair                                 |
| POST   | `/api/v1/auth/refresh`           | exchange of a refresh token for a new pair with rotation                                      |
| POST   | `/api/v1/auth/logout`            | revocation of the session by refresh token                                                    |
| POST   | `/api/v1/auth/logout-all`        | revocation of all sessions                                                                    |
| GET    | `/api/v1/auth/me`                | current user                                                                                  |
| GET    | `/api/v1/auth/keys`              | cryptographic material of the user                                                            |
| POST   | `/api/v1/auth/password`          | password change with a re-encrypted master key                                                |
| GET    | `/api/v1/auth/sessions`          | active sessions                                                                               |
| DELETE | `/api/v1/auth/sessions/{id}`     | revocation of one particular session                                                          |
| POST   | `/api/v1/auth/recovery/start`    | recovery code check, the response carries the master key wrapped with it and a recovery token |
| POST   | `/api/v1/auth/recovery/complete` | new authentication data by recovery token                                                     |

The access token is a JWT (HS256) with a short TTL, the refresh token is a random value and
only its sha256 is stored in `sessions`. The refresh token is single-use: presenting an
already used token again is treated as theft and revokes all sessions of the user.

For an unknown login `prelogin` returns a deterministic pseudorandom salt so the endpoint
does not reveal whether the account exists.

### Access recovery

From the recovery code the client derives two independent values: the master key wrapping
key (stays on the device) and `recovery_auth_hash` — the verifier for the server.
`recovery_keys.verifier_hash` holds an Argon2id hash of the verifier, so the master key
cannot be unwrapped with it.

1. `recovery/start` with the login and `recovery_auth_hash` — the server checks the verifier
   and only then hands out the wrapped master key together with a recovery token
   (`auth.recovery_ttl`, 10 minutes by default);
2. the client unwraps the master key with the recovery code and re-encrypts it with a key
   from the new password;
3. `recovery/complete` with the recovery token and the new data — the server applies them
   and revokes all sessions.

The recovery token is signed with a separate scope, so it does not work as an access token
and vice versa. It is single-use: the `fpr` claim holds an HMAC of the `auth_hash` that was
in effect when it was issued, and after a successful reset (or a password change through
`/password`) the fingerprint stops matching. No state is kept for that.

The master key does not change during recovery, so the identity keypairs and every
encrypted note stay valid.

## The API

Everything below `/api/v1`. Request bodies are validated before any business logic runs;
successes return a bare DTO, failures the envelope `{"error":{code,message,details,request_id}}`.

A resource the caller cannot see answers **404, not 403** — otherwise an id becomes an
oracle for what exists. 403 is reserved for "you can see this, but not do that".

| Area          | Endpoints                                                                                                                                 |
|---------------|-------------------------------------------------------------------------------------------------------------------------------------------|
| Vaults        | `POST/GET /vaults`, `GET/PATCH/DELETE /vaults/{id}`, `PUT /vaults/{id}/label`, `/keys`, `/scopes`, `/tree`, `/sync`, `/trash`, `/audit`, `/graph` |
| Folders       | `POST /vaults/{id}/folders`, `PATCH /folders/{id}`, `/move`, `DELETE`, `/restore`, `/purge`                                                 |
| Notes         | `POST /vaults/{id}/files`, `POST /vaults/{id}/files/bulk`, `GET/PATCH/DELETE /files/{id}`, `PUT /files/{id}/content`, `/move`, `/restore`, `/purge` |
| Groups        | `GET/POST /vaults/{id}/groups`, `GET /vaults/{id}/group-keys`, `PATCH/DELETE /groups/{id}`, `PUT /groups/{id}/members` |
| Access        | `GET /vaults/{id}/members`, `PATCH/DELETE /vaults/{id}/members/{member_id}`, `POST /vaults/{id}/leave`, `GET/PUT /vaults/{id}/grants`, `DELETE /vaults/{id}/grants/{grant_id}`, `GET /users/lookup` |
| Invites       | `POST/GET /vaults/{id}/invites`, `DELETE /vaults/{id}/invites/{invite_id}`, `POST /invites/lookup` (anonymous), `POST /invites/redeem`, `GET /me/invites` |
| Keys          | `POST /vaults/{id}/rekeys`, `PUT /rekeys/{id}/items`, `POST /rekeys/{id}/commit`, `DELETE /rekeys/{id}`                                     |
| Graph         | `PUT /files/{id}/links`, `GET /files/{id}/backlinks`, `GET /vaults/{id}/graph`                                                              |
| History       | `GET /files/{id}/revisions`, `GET /files/{id}/revisions/{revision_id}`                                                                     |
| Sharing       | `POST/GET /files/{id}/share-links`, `DELETE /share-links/{id}`, `POST /public/share/lookup` (anonymous)                                     |
| Realtime      | `GET /realtime` — the live editing socket. Frames are described below, not in swagger, which documents bodies and a socket has none          |

The sync endpoint is what the rest rests on. Cursors are per-vault change sequences rather
than timestamps: two rows committed in one transaction share a `now()`, and a cursor by time
would silently skip whichever one a concurrent reader slipped between. When a member's
`access_seq` runs ahead of the cursor the response carries `full_resync_required`, which is
the only mechanism by which a client learns to drop plaintext it cached before losing access
to it.

Neither anonymous endpoint takes a secret in the URL. Both take the digest of one in a POST
body — a token in a path lands in every access log, including this service's own.

### The socket

`GET /api/v1/realtime` carries JSON frames, `[]byte` fields base64 like everywhere else. It
authenticates in its first frame rather than in a header, for the reason just given: a
browser cannot set `Authorization` on a websocket, and a token in the query string would
land in the access log the paragraph above is about.

| Direction | Frames |
|-----------|--------|
| To server | `auth` (must be first, and again to renew before the 15-minute token expires), `subscribe`, `open`, `seed`, `update`, `awareness`, `close` |
| From server | `ready`, `subscribed`, `changed`, `doc`, `absent`, `update`, `awareness`, `presence`, `ack`, `reseed`, `error` |

`changed` is the whole of the tree's liveness: it carries a vault id and a change sequence,
and the client pulls the delta through `/vaults/{id}/sync` as it always did. Pushing the
rows themselves would mean a second way to apply a change, kept in agreement with the first.

Writing needs `edit` and reading needs `view`, checked through the same resolver the REST
handlers use. A reader's `update` is refused and not relayed; their `awareness` is relayed,
because somebody who cannot write still has a caret and the presence list would otherwise
be lying about who is here.

## Configuration

Source priority (ascending): defaults in the code → `configs/config.yaml` → `.env` →
environment variables. The variable name is built from the key path with the `SHELF_`
prefix:

| Config key          | Environment variable      |
|---------------------|---------------------------|
| `http.port`         | `SHELF_HTTP_PORT`         |
| `postgres.password` | `SHELF_POSTGRES_PASSWORD` |
| `auth.secret`       | `SHELF_AUTH_SECRET`       |
| `log.level`         | `SHELF_LOG_LEVEL`         |

The path to the YAML file is overridden by `SHELF_CONFIG_PATH`. Secrets are never stored in
`configs/config.yaml`.

**`auth.secret`** (at least 32 characters) signs the access tokens and is required in every
environment except `local`; locally an empty value makes the service generate an ephemeral
secret, so issued tokens become invalid after a restart.

**`http.trusted_proxies`** must be filled in behind a reverse proxy. Every per-address rate
limit relies on `c.ClientIP()`, and without it every request arrives from the proxy address
and the limits become shared by everyone.

**`http.max_body_bytes`** (8 MiB) caps every request body. gin imposes no limit of its own.

### The connector

| Key                    | Environment variable          | Notes                                                                     |
|------------------------|-------------------------------|---------------------------------------------------------------------------|
| `mcp.enabled`          | `SHELF_MCP_ENABLED`           | Off by default. With it off none of the routes exist                       |
| `mcp.secret`           | `SHELF_MCP_SECRET`            | Wraps the connector keys at rest, at least 32 characters                   |
| `mcp.public_base_url`  | `SHELF_MCP_PUBLIC_BASE_URL`   | The address entered in Claude, byte for byte. Required when enabled        |

Unlike `auth.secret` there is no ephemeral fallback anywhere, `local` included: a generated
secret would make every connector key already in the database unopenable after the first
restart, and the failure would read as corruption rather than as a missing setting. The
service refuses to start instead.

`public_base_url` is configured rather than taken from the request Host because the protected
resource metadata has to name the same URL the person typed, and a proxy that rewrites Host
would otherwise break discovery in a way nothing here can see.

With `mcp.enabled` off, none of the connector routes are mounted at all. The client asks
`GET /api/v1/features` before it offers to connect anything, because a route that was never
mounted answers exactly like one that is broken — and finding out afterwards would mean a
vault created for a connector that cannot be attached to it.

`docker-compose.yml` passes all three through, so a deployment turns the connector on by
setting them in the environment rather than by editing the image.

### Rate limiting

A token bucket sits on the endpoints where a secret can be guessed
(`auth.rate_limit`, defaults in [configs/config.yaml](configs/config.yaml)):

| Counter            | Key            | Default           | Why                                           |
|--------------------|----------------|-------------------|-----------------------------------------------|
| `login_ip`         | client address | 10 per 5 minutes  | guessing from a single address                |
| `login_account`    | login          | 20 per 15 minutes | guessing one account from different addresses |
| `recovery_ip`      | client address | 5 per 15 minutes  | recovery code guessing                        |
| `recovery_account` | login          | 10 per hour       | the same, distributed                         |
| `invite_ip`        | client address | 20 per 15 minutes | invite-code lookups                           |
| `share_ip`         | client address | 60 per 15 minutes | public-link lookups                           |
| `register_ip`      | client address | 20 per hour       | registration runs Argon2id twice at 64 MiB    |

A successful request gives the spent attempt back, so an ordinary user never hits the limit
— only failures spend the counter. The per-account counter is applied *after* the password
is checked rather than before: spending it up front would let anybody who knows a login lock
its owner out for the window by guessing wrong. The cost is that it no longer saves the
Argon2id work — the per-address limit is what bounds that, and a distributed attack was never
bounded by punishing the account it was aimed at.

Each limiter holds at most `ratelimit.MaxKeys` buckets. Several of them are keyed by
something the caller chooses, so at the cap a *new* key is refused rather than an old one
forgotten: resetting would hand an attacker a way to clear everybody's counters. Neither an invite code nor a link secret is short enough
to brute force; the limits are there so the endpoints are not free oracles. On rejection a
`429` with `Retry-After` is returned. The counters live in process memory: with several
instances the limit applies to each of them separately. `auth.rate_limit.enabled: false`
turns the checks off entirely.

## Migrations

The migrations are embedded in the binary and applied on startup, so a fresh database and a
new image need nothing else: the service brings the schema to the version it was built
against before it serves a request. The driver takes a Postgres advisory lock first, so
several replicas starting at once is safe — one migrates and the rest find nothing to do.

Two cases stop the service rather than letting it run against a schema it does not expect.
A database left dirty by a half-applied migration is one: nothing can work out how far that
migration got, so it has to be looked at and cleared with `make migrate-force`. A database
ahead of the binary is the other, which is what a rollback to an older image looks like.

Set `postgres.auto_migrate: false` (`SHELF_POSTGRES_AUTO_MIGRATE=false`) where something
else owns the schema — a managed database with its own pipeline, or a replica that must not
race the instance that migrates.

The same migrations are driven by hand during development, through the same
`schema_migrations` table, so the two paths cannot disagree about where the database stands:

```bash
make migrate-create name=add_books   # a new .up.sql/.down.sql pair
make migrate-up                      # apply
make migrate-down                    # roll the last one back
make migrate-version                 # current schema version
make migrate-force version=1         # clear the dirty flag
```

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

### Deployment

The shipped `configs/config.yaml` is the local profile and is what the container image
bakes in, so its values are production defaults whether or not anyone meant them to be.
Four of them have to be set for any real deployment:

| Setting                  | Why                                                                        |
|--------------------------|----------------------------------------------------------------------------|
| `SHELF_AUTH_SECRET`      | without it every restart invalidates every token                           |
| `SHELF_APP_ENV`          | `local` keeps gin in debug mode and permits an empty auth secret            |
| `http.trusted_proxies`   | otherwise every per-IP limit sees only the proxy and becomes one shared bucket |
| `http.handler_timeout`   | bounds the work behind a request; ten slow queries would otherwise take the pool |
| `postgres.ssl_mode`      | `require` or `verify-full` whenever Postgres is not on this host            |

A value in `.env` is substituted into `docker-compose.yml`, not handed to the container, so
anything the app needs has to be named in its `environment` block. `SHELF_AUTH_SECRET` is
passed through there for exactly that reason.

The schema needs no separate step: the image carries its migrations and applies them once
Postgres is reachable.

`make docker-up` is a development convenience: it publishes Postgres on the host with a
default password and is not meant to run anywhere else.

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
