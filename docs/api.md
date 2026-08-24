# The API

[← README](../README.md) ·
[Architecture](architecture.md) ·
[Security](security.md) ·
[Connector](mcp.md) ·
[Deployment](deploy.md) ·
[API](api.md)

---

The generated Swagger specification lives in [docs/swagger.yaml](swagger.yaml) and is served
by the service itself at `/swagger/index.html`. What follows is the shape of the API and the
few decisions a specification cannot express.


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

## The socket

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

