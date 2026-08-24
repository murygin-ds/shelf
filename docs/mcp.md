# The Claude connector

[← README](../README.md) ·
[Architecture](architecture.md) ·
[Security](security.md) ·
[Connector](mcp.md) ·
[Deployment](deploy.md) ·
[API](api.md)

---


This is the one place where the promise the rest of this project makes does not hold, and it
is worth saying so before explaining how it works: **a vault with a connector is readable by
this server.** Not the metadata, not the shape — the folder names, the titles and the bodies.

The reason is unavoidable rather than clever. Claude reaches a vault over HTTPS from
Anthropic's network, so something on this side has to turn ciphertext into text. There is no
arrangement in which a remote assistant reads a vault and the server does not. What can be
arranged is that it is an exception: one vault at a time, only after its owner asked for it,
and undone by removing a member.

## It is a member, not a mechanism

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

## Getting the key to it

Two requests, because a key cannot be sealed to a public key that does not exist yet. The
first mints the identity and admits it with `key_state = pending_key` — a member that reads
nothing. The second seals the vault's scope key to it and writes the grant, in the one
transaction that justifies writing one. Only the vault's own scope is sealed, which is why a
folder with its own key stays private without a second mechanism for it.

## What Claude can do

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
in the log. The mark rides on the note itself, so every tool that answers with one carries
`pending_edits` — the listing, the search, the read, and the move and rename that only touch
its metadata. A model sees the body, or a snippet of it, knowing that it is not the whole of
the note and that writing to it will be refused. A write that succeeds clears it by
construction: there is nothing left in the log for the body not to carry.

A connector admitted as a viewer is not offered the writing tools at all, rather than offered
tools that refuse. A model shown a tool will try it.

## Reaching it

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

## The view

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

## Two things the vault says to Claude itself

The template a Claude vault is created with carries both in its root document, because a
warning shown once in a dialog is a warning nobody re-reads: that this vault is readable by
the server and must not hold credentials, and that everything in it is data rather than
instructions. A note that tells the model to ignore its instructions is a note somebody
wrote.


## Configuration

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

