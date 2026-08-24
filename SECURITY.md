# Security policy

Shelf keeps note contents encrypted on the client, so most of what could go wrong here is a
security bug rather than a feature request. Reports are welcome.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on
[the repository](https://github.com/murygin-ds/shelf/security/advisories/new). It opens a
private thread with the maintainer and does not disclose anything until an advisory is
published.

<!-- TODO: add a contact address here if you want a channel outside GitHub. -->

Please do not open a public issue for a vulnerability before we have had a chance to reply.

What helps: the version or commit, whether the server had the connector enabled, and the
smallest sequence of requests that reproduces the problem. A proof of concept against a local
install is ideal; please do not test against somebody else's deployment.

Expect an acknowledgement within seven days. There are no releases yet, so a fix lands on
`main` and the advisory says which commit carries it.

## Supported versions

`main` only. The project has not tagged a release, and older commits do not receive
backported fixes.

## What counts as a vulnerability

The claim this project makes is that the server never holds a key that opens note contents.
Anything that breaks it is in scope:

- The server, or anyone with a database dump, recovering plaintext of a vault that has no
  connector.
- Reading, writing or reaching a vault, folder or note without the permission that allows it,
  including through the sync, graph, revision, invite, public-link or realtime paths.
- Forging a signature, or getting a client to accept content signed by somebody who is not
  the author it is attributed to.
- Moving a ciphertext from one slot to another so that it decrypts in a place it was never
  written for.
- Key material leaking anywhere it should not be: logs, error messages, URLs, the token
  tables, or a response to a caller who should not see it.
- Authentication and session flaws: token forgery, refresh-token replay that is not detected,
  recovery-code bypass, an oracle that reveals whether an account exists.
- The usual web classes in the app itself — XSS through rendered Markdown, CSRF, path
  traversal in the archive import, SSRF from the server.

## Known and documented limits

These are stated in the README and the docs. They are design decisions, not findings, and a
report describing one of them will be closed as such:

- **A vault with a Claude connector is readable by the server.** That is the entire point of
  the connector, it is announced in the interface and in the vault's own root document, and it
  applies to that vault only.
- **Metadata is visible to the server**: the shape of the tree, sizes to a 4 KiB granularity,
  timestamps, membership, the link graph, and the rhythm of typing during a live session. See
  [docs/security.md](docs/security.md) for the full list.
- **Rotation protects future reads.** Removing a member does not un-read what they already
  read.
- **A public link is a snapshot** carrying its own copy of the note under a key derived from
  the URL fragment. Anyone with the link has the note.
- **An unlocked tab holds plaintext in memory.** Physical or malware-level access to an
  unlocked device is outside the model.
- **A malicious server can withhold or reorder data.** It cannot read or forge content, but it
  is not obliged to answer honestly.
