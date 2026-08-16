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

It does not learn: note titles, bodies, folder names, icons, tags, search queries, or the
text of any link that did not resolve.

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

## Layout

```
cmd/server/            entry point, swagger annotations of the general information
internal/
  app/                 dependency wiring, startup and graceful shutdown
  api/                 root router, health probes, SPA fallback, error format
    middleware/         request id, logging, recovery, CORS, body limit, auth, rate limit
    request/            binding, id and If-Match helpers
    response/           response and error helpers
    v1/{auth,vault,access}/   handlers and DTOs per feature
  auth/                registration, login, sessions, tokens, Argon2id
  vault/               the domain: permissions, scopes, sync, re-key, graph, revisions,
                       sharing, audit. No SQL and no HTTP.
    accesscases/        the permission truth table both implementations are held to
  access/              members, grants, invites
  config/ logger/ ratelimit/
  storage/postgres/    pgxpool and the repositories, including the permission CTE
  web/                 go:embed of the built frontend
web/src/
  crypto/              kdf, aead, sealed box, identity, keyring, envelope, signatures
  api/                 one module per resource; every []byte field typed as base64
  db/                  IndexedDB cache — ciphertext only
  sync/                delta pull, hydration, the local search index
  store/               zustand: session and workspace
  lib/                 wikilink resolution, the search index, passphrase strength
  ui/                  icons and the shared primitives
  styles/              the design tokens everything else reads
  features/            auth, shell, sidebar, editor, search, graph, inspector, access, share
configs/               config.yaml
migrations/            golang-migrate SQL migrations
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

**A write that meets no network is queued, not lost.** The body is sealed first, so what
waits in IndexedDB is ciphertext like everything else there, and one entry per note — a body
write replaces the whole body, so only the newest attempt is worth keeping. It goes out on
reconnect, on the next visible tick, and when the vault is opened again. A conflict during
that replay is dropped rather than retried forever: nobody but a client can merge two
ciphertexts, and a queued copy that will be refused every time is not a copy worth keeping.

**A missing key is a state, not an error.** `decryptMeta` returns a locked marker instead of
throwing, which is why greyed rows in the tree and `••••••` in the graph fall out naturally
rather than through a try/catch in forty places.

**Writes carry an optimistic lock.** `PUT /files/{id}/content` takes `If-Match:
<content_seq>` and also names the key version it sealed under — a re-key moves the row to a
new key without touching that sequence, so a write held up across a rotation has to be
refused rather than accepted and relabelled.

**Every body is signed.** `view`, `comment` and `edit` are the same key, so without a
signature any reader could produce ciphertext that decrypts and no reader could tell. The
signature covers the slot as well as the bytes, and the reader checks the author's key
against the member list it already holds rather than against whatever arrived with the
revision.

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
| Vaults        | `POST/GET /vaults`, `GET/PATCH/DELETE /vaults/{id}`, `/keys`, `/scopes`, `/tree`, `/sync`, `/trash`, `/audit`, `/graph`                     |
| Folders       | `POST /vaults/{id}/folders`, `PATCH /folders/{id}`, `/move`, `DELETE`, `/restore`, `/purge`                                                 |
| Notes         | `POST /vaults/{id}/files`, `POST /vaults/{id}/files/bulk`, `GET/PATCH/DELETE /files/{id}`, `PUT /files/{id}/content`, `/move`, `/restore`, `/purge` |
| Groups        | `GET/POST /vaults/{id}/groups`, `GET /vaults/{id}/group-keys`, `PATCH/DELETE /groups/{id}`, `PUT /groups/{id}/members` |
| Access        | `GET /vaults/{id}/members`, `PATCH/DELETE /vaults/{id}/members/{member_id}`, `POST /vaults/{id}/leave`, `GET/PUT /vaults/{id}/grants`, `DELETE /vaults/{id}/grants/{grant_id}`, `GET /users/lookup` |
| Invites       | `POST/GET /vaults/{id}/invites`, `DELETE /vaults/{id}/invites/{invite_id}`, `POST /invites/lookup` (anonymous), `POST /invites/redeem`, `GET /me/invites` |
| Keys          | `POST /vaults/{id}/rekeys`, `PUT /rekeys/{id}/items`, `POST /rekeys/{id}/commit`, `DELETE /rekeys/{id}`                                     |
| Graph         | `PUT /files/{id}/links`, `GET /files/{id}/backlinks`, `GET /vaults/{id}/graph`                                                              |
| History       | `GET /files/{id}/revisions`, `GET /files/{id}/revisions/{revision_id}`                                                                     |
| Sharing       | `POST/GET /files/{id}/share-links`, `DELETE /share-links/{id}`, `POST /public/share/lookup` (anonymous)                                     |

The sync endpoint is what the rest rests on. Cursors are per-vault change sequences rather
than timestamps: two rows committed in one transaction share a `now()`, and a cursor by time
would silently skip whichever one a concurrent reader slipped between. When a member's
`access_seq` runs ahead of the cursor the response carries `full_resync_required`, which is
the only mechanism by which a client learns to drop plaintext it cached before losing access
to it.

Neither anonymous endpoint takes a secret in the URL. Both take the digest of one in a POST
body — a token in a path lands in every access log, including this service's own.

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
