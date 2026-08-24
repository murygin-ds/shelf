# Security model

[← README](../README.md) ·
[Architecture](architecture.md) ·
[Security](security.md) ·
[Connector](mcp.md) ·
[Deployment](deploy.md) ·
[API](api.md)

---

Everything here follows from one decision: keys are derived and used on the device, and the
server is handed only what it cannot open. This document states the mechanism and, at the
end, exactly where the edges of that promise are.

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
[a differential test](../internal/storage/postgres/access_integration_test.go) drives both
over [the same table](../internal/vault/accesscases/cases.go) so they cannot drift.

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
this server in full, deliberately and visibly — see [the connector](mcp.md). No other
vault is affected: the server holds no key to them and has no way to obtain one.

