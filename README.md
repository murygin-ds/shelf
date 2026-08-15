# Shelf Backend

REST API of the Shelf service.

## Stack

| Layer         | Technology                                                    |
|---------------|---------------------------------------------------------------|
| HTTP          | [gin](https://github.com/gin-gonic/gin)                       |
| Database      | PostgreSQL + [pgx/v5](https://github.com/jackc/pgx) (pgxpool) |
| Configuration | [viper](https://github.com/spf13/viper) + `.env` (godotenv)   |
| Logs          | [zap](https://github.com/uber-go/zap)                         |
| Documentation | [swaggo](https://github.com/swaggo/swag)                      |
| Migrations    | [golang-migrate](https://github.com/golang-migrate/migrate)   |

## Quick start

```bash
make env         # .env from .env.example
make db-up       # PostgreSQL in docker
make migrate-up  # apply the migrations
make run         # start the service
```

- API: `http://localhost:8080`
- Swagger UI: `http://localhost:8080/swagger/index.html`
- Probes: `GET /health` (liveness), `GET /ready` (readiness, pings the database)

`make help` lists every command.

## Configuration

Source priority (ascending): defaults in the code → `configs/config.yaml` → `.env` → environment variables.

The variable name is built from the key path with the `SHELF_` prefix:

| Config key          | Environment variable      |
|---------------------|---------------------------|
| `http.port`         | `SHELF_HTTP_PORT`         |
| `postgres.password` | `SHELF_POSTGRES_PASSWORD` |
| `auth.secret`       | `SHELF_AUTH_SECRET`       |
| `log.level`         | `SHELF_LOG_LEVEL`         |

The path to the YAML file is overridden by `SHELF_CONFIG_PATH`. Secrets are never stored in `configs/config.yaml`.

`auth.secret` (at least 32 characters) signs the access tokens and is required in every environment except `local`;
locally an empty value makes the service generate an ephemeral secret, so issued tokens become invalid after a restart.

## Layout

```
cmd/server/            entry point, swagger annotations of the general information
internal/
  app/                 dependency wiring, startup and graceful shutdown
  api/                 root router, health probes, common error format
    middleware/         request id, logging, recovery, CORS, access token check
    response/           response and error helpers
    v1/                 routes of the first API version
      auth/             authentication handlers and DTOs
  auth/                business logic: registration, login, sessions, tokens, Argon2id
  config/              configuration loading and validation
  logger/              zap initialization
  ratelimit/           token bucket for request rate limiting
  storage/postgres/    pgxpool connection pool and repositories
configs/               config.yaml
migrations/            golang-migrate SQL migrations
docs/                  generated swagger specification
```

## Authentication

The storage is end-to-end encrypted: the server knows neither the password nor the master key. Using
`kdf_salt`/`kdf_params` the client derives two values from the password — the master key wrapping key (stays on the
device) and `auth_hash` (goes to the server). The database holds an Argon2id hash of `auth_hash` and the keys wrapped
by the client.

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

The access token is a JWT (HS256) with a short TTL, the refresh token is a random value and only its sha256 is stored
in `sessions`. The refresh token is single-use: presenting an already used token again is treated as theft and revokes
all sessions of the user.

For an unknown login `prelogin` returns a deterministic pseudorandom salt so the endpoint does not reveal whether the
account exists.

### Rate limiting

`login` and `recovery/start` are the only endpoints where the password and the recovery code are guessed, so a token
bucket sits on them (the `auth.rate_limit` section, defaults in [configs/config.yaml](configs/config.yaml)):

| Counter            | Key            | Default           | Why                                           |
|--------------------|----------------|-------------------|-----------------------------------------------|
| `login_ip`         | client address | 10 per 5 minutes  | guessing from a single address                |
| `login_account`    | login          | 20 per 15 minutes | guessing one account from different addresses |
| `recovery_ip`      | client address | 5 per 15 minutes  | recovery code guessing                        |
| `recovery_account` | login          | 10 per hour       | the same, distributed                         |

A successful request gives the spent attempt back, so an ordinary user never hits the limit — only failures spend the
counter. On rejection a `429` with `Retry-After` is returned. The counters live in process memory: with several
instances the limit applies to each of them separately. `auth.rate_limit.enabled: false` turns the checks off entirely.

The per-address limit relies on `c.ClientIP()`, so behind a reverse proxy `http.trusted_proxies` must be filled in —
otherwise every request arrives from the proxy address and the limit becomes shared by everyone.

### Access recovery

From the recovery code the client derives two independent values: the master key wrapping key (stays on the device)
and `recovery_auth_hash` — the verifier for the server. `recovery_keys.verifier_hash` holds an Argon2id hash of the
verifier, so the master key cannot be unwrapped with it.

1. `recovery/start` with the login and `recovery_auth_hash` — the server checks the verifier and only then hands out
   the wrapped master key together with a recovery token (`auth.recovery_ttl`, 10 minutes by default);
2. the client unwraps the master key with the recovery code and re-encrypts it with a key from the new password;
3. `recovery/complete` with the recovery token and the new data — the server applies them and revokes all sessions.

The recovery token is signed with a separate scope, so it does not work as an access token and vice versa.
It is single-use: the `fpr` claim holds an HMAC of the `auth_hash` that was in effect when it was issued, and after a
successful reset (or a password change through `/password`) the fingerprint stops matching. No state is kept for that.

The master key does not change during recovery, so the public/private key pair and the encrypted data stay valid.

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
make swagger   # regenerate docs/ after changing the annotations
make check     # fmt + vet + lint + tests
make tools     # install swag, migrate, golangci-lint
```
