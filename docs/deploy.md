# Deployment

[← README](../README.md) ·
[Architecture](architecture.md) ·
[Security](security.md) ·
[Connector](mcp.md) ·
[Deployment](deploy.md) ·
[API](api.md)

---

## Installing on a server

One command, on a fresh Debian or Ubuntu machine whose domain already points at it:

```bash
curl -fsSL https://raw.githubusercontent.com/murygin-ds/shelf/main/install.sh \
  | sudo bash -s -- --domain notes.example.com --email you@example.com
```

The `-s --` is not decoration: without it bash reads the first flag as a filename.

What it does, in order: checks the machine can build this and then serve it, installs Docker
if it is missing, clones the repository into `/opt/shelf`, writes `/opt/shelf/.env` with three
generated secrets, builds the image, starts Postgres and the service behind Caddy, and waits
until the domain answers over a certificate Let's Encrypt has just issued. Given both flags it
asks nothing; given neither it asks for both.

Piping a script into a root shell is a decision rather than a convenience, and this one makes
no network call its flags do not name. Reading it first is reasonable:

```bash
curl -fsSL https://raw.githubusercontent.com/murygin-ds/shelf/main/install.sh -o install.sh
less install.sh
sudo bash install.sh --domain notes.example.com --email you@example.com
```

### What it needs

| Requirement      | Why                                                                                                          |
|------------------|--------------------------------------------------------------------------------------------------------------|
| A domain         | Every key is derived in the browser through WebCrypto, which no page served over plain HTTP may use            |
| An A record      | Pointed here before the run: Let's Encrypt answers the challenge at the address DNS gives it, on port 80       |
| Ports 80 and 443 | Free, 443 over UDP as well — Caddy offers HTTP/3, and a browser only finds it if the port is published         |
| 2 GB of memory   | The frontend and the binary are compiled here. Below that the build is killed rather than slowed, and the script offers a swap file |
| 8 GB of disk     | Images, build caches and the database                                                                          |
| root             | For `/opt/shelf`, for the Docker daemon, and for binding 443                                                   |

Debian 11 or newer, Ubuntu 20.04 or newer, or anything else that already has Docker Engine with
the Compose v2 and Buildx plugins. Buildx is not optional: the Dockerfile caches its dependency
downloads through `RUN --mount=type=cache`, which the legacy builder refuses outright.

### Flags

Each has an environment variable of the same meaning, so a whole run can be described without a
single flag.

| Flag                   | Environment                  | Default        | Meaning                                                             |
|------------------------|------------------------------|----------------|-----------------------------------------------------------------------|
| `--domain`             | `SHELF_DOMAIN`               | asked          | The name on the certificate, and the address given to Claude           |
| `--email`              | `ACME_EMAIL`                 | asked          | Where Let's Encrypt sends expiry notices                               |
| `--enable-mcp`         | `SHELF_MCP_ENABLED`          | asked          | Mount the connector and generate the key that wraps its credentials    |
| `--no-mcp`             |                              |                | The same decision, without the question                                |
| `--dir`                | `SHELF_INSTALL_DIR`          | `/opt/shelf`   | Where the clone and `.env` live                                        |
| `--repo`, `--branch`   | `SHELF_REPO`, `SHELF_BRANCH` | this repo, `main` | Install from a fork or a branch                                     |
| `--image`              | `SHELF_IMAGE`                | built here     | Use a prebuilt image instead of compiling                              |
| `--staging`            |                              | off            | Issue from Let's Encrypt staging: untrusted certificates, generous limits |
| `--swap`, `--no-swap`  |                              | asked below 2 GB | Create `/swapfile` so the build survives                             |
| `--skip-dns-check`     |                              | off            | Proceed although the domain does not resolve here                      |
| `--non-interactive`    | `SHELF_NONINTERACTIVE`       | off            | Never ask; a missing answer is an error                                |
| `--yes`                |                              | off            | Answer yes to every confirmation                                       |
| `--update`             |                              |                | Pull, rebuild and restart, keeping `.env` and every secret in it       |
| `--force`              |                              | off            | With `--update`, discard local edits to tracked files                  |
| `--uninstall`          |                              |                | Stop and remove the containers; the volumes stay                       |
| `--purge`              |                              |                | With `--uninstall`, delete the database and the certificates too       |

### What it writes

`/opt/shelf/.env`, owned by root and readable by nobody else, is the only file the script
generates, and the only place three values exist:

| Value                     | Losing it costs                                                                            |
|---------------------------|----------------------------------------------------------------------------------------------|
| `SHELF_AUTH_SECRET`       | Every session. Nobody's data, everybody's next sign-in                                        |
| `SHELF_POSTGRES_PASSWORD` | Access to the database, whose volume still holds the old one                                  |
| `SHELF_MCP_SECRET`        | Every connector credential, permanently: there is no fallback, and nothing derives it again   |

Running the script again reads all three back out of that file rather than generating new ones,
which is what makes `--update` safe and what makes a restored `.env` work.

Local proxy configuration goes in `/opt/shelf/caddy.d/*.caddy`, which is imported into the site
block and is not tracked, so it survives updates instead of conflicting with them.

### Afterwards

```bash
cd /opt/shelf                    # .env names the compose file, so nothing here needs a flag
docker compose logs -f app       # the service
docker compose logs -f caddy     # TLS and access
docker compose ps                # what is running
docker compose restart app       # restart without rebuilding
```

The first account is made by whoever opens `/signup`. There is no invitation step, no
administrator account to create first, and no setting that closes registration — roles exist
inside a vault, not above one. A deployment that should not be joinable by anyone who finds it
needs something in front of it deciding who reaches it at all.

### What it does not do

Backups, of the database or of `.env`. Monitoring. A firewall — and note that Docker publishes
its ports past `ufw`, so a host that looks closed is not. Major-version upgrades of Postgres,
which need a dump and a restore rather than a new image tag.

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

The connector has three settings of its own; they are described in
[the connector's own document](mcp.md#configuration).

### Rate limiting

A token bucket sits on the endpoints where a secret can be guessed
(`auth.rate_limit`, defaults in [configs/config.yaml](../configs/config.yaml)):

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

## A deployment put together by hand

[Installing on a server](#installing-on-a-server) settles everything below on its own; this
is what it settles, for a deployment put together by hand.

The shipped `configs/config.yaml` is the local profile and is what the container image
bakes in, so its values are production defaults whether or not anyone meant them to be.
Five of them have to be set for any real deployment:

| Setting                  | Why                                                                        |
|--------------------------|----------------------------------------------------------------------------|
| `SHELF_AUTH_SECRET`      | without it every restart invalidates every token                           |
| `SHELF_APP_ENV`          | `local` keeps gin in debug mode and permits an empty auth secret            |
| `http.trusted_proxies`   | otherwise every per-IP limit sees only the proxy and becomes one shared bucket |
| `http.handler_timeout`   | bounds the work behind a request; ten slow queries would otherwise take the pool |
| `postgres.ssl_mode`      | `require` or `verify-full` whenever Postgres is not on this host            |

A value in `.env` is substituted into a compose file, not handed to the container, so anything
the app needs has to be named in its `environment` block. `SHELF_AUTH_SECRET` is passed through
there for exactly that reason, in `docker-compose.yml` and in `compose.prod.yml` alike.

The schema needs no separate step: the image carries its migrations and applies them once
Postgres is reachable.

`make docker-up` is a development convenience: it publishes Postgres on the host with a
default password and is not meant to run anywhere else. `compose.prod.yml` is the one that is:
it publishes nothing but Caddy's own ports, and the database is reachable only from the service.

