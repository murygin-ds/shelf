// Package config loads the application configuration.
//
// Value sources in ascending order of priority:
//  1. default values (see setDefaults);
//  2. the YAML file (configs/config.yaml by default, the path is overridden by SHELF_CONFIG_PATH);
//  3. environment variables from the .env file;
//  4. environment variables of the process.
//
// The environment variable name is built from the key path: http.read_timeout -> SHELF_HTTP_READ_TIMEOUT.
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"reflect"
	"strconv"
	"strings"
	"time"

	"github.com/go-playground/validator/v10"
	"github.com/joho/godotenv"
	"github.com/spf13/viper"
)

const (
	// EnvPrefix is the common prefix of the environment variables
	EnvPrefix = "SHELF"

	// EnvConfigPath is the environment variable holding the path to the YAML config
	EnvConfigPath = EnvPrefix + "_CONFIG_PATH"

	defaultConfigPath = "configs/config.yaml"
)

// Application environments
const (
	EnvLocal = "local"
	EnvDev   = "dev"
	EnvStage = "stage"
	EnvProd  = "prod"
)

// Config is the root configuration of the application
type Config struct {
	App      App      `mapstructure:"app"`
	HTTP     HTTP     `mapstructure:"http"`
	Postgres Postgres `mapstructure:"postgres"`
	Auth     Auth     `mapstructure:"auth"`
	Realtime Realtime `mapstructure:"realtime"`
	Log      Log      `mapstructure:"log"`
}

// App holds the general service parameters
type App struct {
	Name string `mapstructure:"name"    validate:"required"`
	Env  string `mapstructure:"env"     validate:"required,oneof=local dev stage prod"`
}

// IsLocal reports whether the service runs in the local environment
func (a App) IsLocal() bool { return a.Env == EnvLocal }

// IsProduction reports whether the service runs in production
func (a App) IsProduction() bool { return a.Env == EnvProd }

// HTTP holds the HTTP server parameters
type HTTP struct {
	Host         string        `mapstructure:"host"`
	Port         int           `mapstructure:"port"             validate:"required,min=1,max=65535"`
	ReadTimeout  time.Duration `mapstructure:"read_timeout"     validate:"required"`
	WriteTimeout time.Duration `mapstructure:"write_timeout"    validate:"required"`
	// HandlerTimeout bounds the work behind a request, not just the socket. Without it a
	// slow query keeps its pool connection and ten of them answer nothing at all
	HandlerTimeout  time.Duration `mapstructure:"handler_timeout" validate:"required"`
	IdleTimeout     time.Duration `mapstructure:"idle_timeout"     validate:"required"`
	ShutdownTimeout time.Duration `mapstructure:"shutdown_timeout" validate:"required"`
	// AllowedOrigins is the list of CORS origins. "*" allows every one of them
	AllowedOrigins []string `mapstructure:"allowed_origins"`
	// TrustedProxies lists the proxies trusted for resolving the client IP
	// An empty list means the X-Forwarded-For headers must not be trusted
	TrustedProxies []string `mapstructure:"trusted_proxies"`
	// SwaggerEnabled turns on serving the Swagger UI at /swagger/index.html
	SwaggerEnabled bool `mapstructure:"swagger_enabled"`
	// MaxBodyBytes caps the request body: gin imposes no limit of its own, and the
	// batch endpoints accept enough ciphertext to be worth bounding
	MaxBodyBytes int64 `mapstructure:"max_body_bytes" validate:"required,min=65536"`
	// StaticCacheMaxAge is the freshness of the hashed frontend assets
	StaticCacheMaxAge time.Duration `mapstructure:"static_cache_max_age" validate:"required"`
}

// Addr returns the listen address in the host:port form
func (h HTTP) Addr() string {
	return net.JoinHostPort(h.Host, strconv.Itoa(h.Port))
}

// Postgres holds the PostgreSQL connection parameters
type Postgres struct {
	Host            string        `mapstructure:"host"               validate:"required"`
	Port            int           `mapstructure:"port"               validate:"required,min=1,max=65535"`
	User            string        `mapstructure:"user"               validate:"required"`
	Password        string        `mapstructure:"password"`
	Database        string        `mapstructure:"database"           validate:"required"`
	SSLMode         string        `mapstructure:"ssl_mode"           validate:"required,oneof=disable allow prefer require verify-ca verify-full"`
	MaxConns        int32         `mapstructure:"max_conns"          validate:"required,min=1"`
	MinConns        int32         `mapstructure:"min_conns"          validate:"min=0"`
	MaxConnLifetime time.Duration `mapstructure:"max_conn_lifetime"  validate:"required"`
	MaxConnIdleTime time.Duration `mapstructure:"max_conn_idle_time" validate:"required"`
	ConnectTimeout  time.Duration `mapstructure:"connect_timeout"    validate:"required"`
	// AutoMigrate applies the migrations embedded in the binary at startup.
	//
	// On by default because the image has no shell to run a migration tool in, and a
	// deployment that needs a second step is a deployment that starts against an empty
	// database. Turn it off where something else owns the schema — a managed database with
	// its own pipeline, or a replica that must not race the instance that migrates.
	AutoMigrate bool `mapstructure:"auto_migrate"`
}

// DSN builds the PostgreSQL connection string
func (p Postgres) DSN() string {
	u := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(p.User, p.Password),
		Host:   net.JoinHostPort(p.Host, strconv.Itoa(p.Port)),
		Path:   p.Database,
	}

	q := u.Query()
	q.Set("sslmode", p.SSLMode)
	u.RawQuery = q.Encode()

	return u.String()
}

// Auth holds the authentication parameters
type Auth struct {
	// Secret is the root secret signing the tokens. Required everywhere except local:
	// there an ephemeral one is generated so the service starts without .env
	Secret string `mapstructure:"secret"      validate:"omitempty,min=32"`
	// Issuer goes into the iss claim of the issued access tokens
	Issuer string `mapstructure:"issuer"      validate:"required"`
	// AccessTTL is the lifetime of an access token
	AccessTTL time.Duration `mapstructure:"access_ttl"  validate:"required"`
	// RefreshTTL is the lifetime of a refresh token (and of the session)
	RefreshTTL time.Duration `mapstructure:"refresh_ttl" validate:"required"`
	// RecoveryTTL is the lifetime of the token proving ownership of the recovery code
	RecoveryTTL time.Duration `mapstructure:"recovery_ttl" validate:"required"`
	// Argon2 holds the parameters of the server-side hashing of the auth_hash sent by the client
	Argon2 Argon2 `mapstructure:"argon2"`
	// RateLimit holds the rate limits of the endpoints where credentials are guessed
	RateLimit RateLimit `mapstructure:"rate_limit"`
}

// RateLimit holds the request rate limits
type RateLimit struct {
	// Enabled turns the limits off entirely, in a test environment for example
	Enabled bool `mapstructure:"enabled"`
	// LoginIP counts login attempts from a single address
	LoginIP Rule `mapstructure:"login_ip"`
	// LoginAccount counts login attempts against a single account from all addresses
	LoginAccount Rule `mapstructure:"login_account"`
	// RecoveryIP counts recovery attempts from a single address
	RecoveryIP Rule `mapstructure:"recovery_ip"`
	// RecoveryAccount counts recovery attempts against a single account from all addresses
	RecoveryAccount Rule `mapstructure:"recovery_account"`
	// InviteIP counts invite-code lookups from a single address. The code carries 125 bits,
	// so this is not what stops a brute force — it stops the endpoint being a free oracle
	InviteIP Rule `mapstructure:"invite_ip"`
	// ShareIP counts public-link lookups from a single address. Same reasoning as InviteIP,
	// with a wider allowance: a note passed round a team is opened from one office
	ShareIP Rule `mapstructure:"share_ip"`
	// RegisterIP counts account creations from a single address. Registration is the one
	// unauthenticated endpoint that runs Argon2id, twice, at 64 MiB
	RegisterIP Rule `mapstructure:"register_ip"`
}

// Rule is the allowed number of requests per window
type Rule struct {
	Limit  int           `mapstructure:"limit"  validate:"required,min=1"`
	Window time.Duration `mapstructure:"window" validate:"required"`
}

// Argon2 holds the parameters of the server-side Argon2id
type Argon2 struct {
	// Memory is the amount of memory in KiB
	Memory uint32 `mapstructure:"memory"      validate:"required,min=8192"`
	// Iterations is the number of passes
	Iterations uint32 `mapstructure:"iterations"  validate:"required,min=1"`
	// Parallelism is the number of threads
	Parallelism uint8 `mapstructure:"parallelism" validate:"required,min=1"`
	// SaltLength is the length of the random salt in bytes
	SaltLength uint32 `mapstructure:"salt_length" validate:"required,min=16"`
	// KeyLength is the length of the resulting hash in bytes
	KeyLength uint32 `mapstructure:"key_length"  validate:"required,min=16"`
}

// Realtime holds the parameters of the live editing socket
type Realtime struct {
	// Enabled turns the socket off entirely. The clients fall back to polling, which is
	// why the endpoint can be disabled without breaking anything but the latency
	Enabled bool `mapstructure:"enabled"`
	// AuthDeadline bounds how long a connection may stay silent before naming itself
	AuthDeadline time.Duration `mapstructure:"auth_deadline"  validate:"required"`
	// ReauthGrace is how long a connection keeps reading after its access token expired.
	// Writes stop immediately; trusting the socket indefinitely would undo the short TTL
	ReauthGrace time.Duration `mapstructure:"reauth_grace"   validate:"required"`
	// PingInterval is the keepalive period. Idle sockets die to intermediaries otherwise
	PingInterval time.Duration `mapstructure:"ping_interval"  validate:"required"`
	// MaxConnsPerUser bounds the goroutines one account can occupy
	MaxConnsPerUser int `mapstructure:"max_conns_per_user" validate:"required,min=1"`
	// MaxFrameBytes caps one inbound frame. Snapshots travel over REST, not here
	MaxFrameBytes int64 `mapstructure:"max_frame_bytes"    validate:"required,min=4096"`
	// SendQueue is the outbound backlog one connection may accumulate before it is
	// closed. A reader too slow to keep up is dropped rather than grown into memory
	SendQueue int `mapstructure:"send_queue"         validate:"required,min=16"`
	// UpdateRate throttles document updates per connection
	UpdateRate Rule `mapstructure:"update_rate"`
}

// Log holds the logging parameters
type Log struct {
	Level  string `mapstructure:"level"  validate:"required,oneof=debug info warn error"`
	Format string `mapstructure:"format" validate:"required,oneof=json console"`
}

// Load reads the configuration from the file, .env and the environment variables
// A missing YAML file or .env is not an error: the service starts on the defaults and env
func Load() (*Config, error) {
	// .env is only needed for local development, in containers the variables come from the environment
	if err := godotenv.Load(); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("load .env: %w", err)
	}

	v := viper.New()
	setDefaults(v)

	path := os.Getenv(EnvConfigPath)
	if path == "" {
		path = defaultConfigPath
	}

	v.SetConfigFile(path)
	if err := v.ReadInConfig(); err != nil {
		if _, ok := errors.AsType[viper.ConfigFileNotFoundError](err); !ok && !os.IsNotExist(err) {
			return nil, fmt.Errorf("read config %q: %w", path, err)
		}
	}

	v.SetEnvPrefix(EnvPrefix)
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()
	bindEnvs(v, Config{})

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("unmarshal config: %w", err)
	}

	if err := validator.New().Struct(cfg); err != nil {
		return nil, fmt.Errorf("validate config: %w", err)
	}

	if err := resolveAuthSecret(&cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// resolveAuthSecret requires the secret in every environment except local, where it substitutes
// an ephemeral one: after a service restart the issued tokens stop being valid
func resolveAuthSecret(cfg *Config) error {
	if cfg.Auth.Secret != "" {
		return nil
	}

	if !cfg.App.IsLocal() {
		return fmt.Errorf("auth.secret is required in %q env (set %s_AUTH_SECRET)", cfg.App.Env, EnvPrefix)
	}

	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return fmt.Errorf("generate ephemeral auth secret: %w", err)
	}

	cfg.Auth.Secret = hex.EncodeToString(buf)

	return nil
}

func setDefaults(v *viper.Viper) {
	v.SetDefault("app.name", "shelf-backend")
	v.SetDefault("app.env", EnvLocal)

	v.SetDefault("http.host", "0.0.0.0")
	v.SetDefault("http.port", 8080)
	v.SetDefault("http.read_timeout", 10*time.Second)
	v.SetDefault("http.write_timeout", 10*time.Second)
	// Comfortably inside write_timeout, so the handler gives up before the socket does and
	// the client gets an error rather than a truncated response.
	v.SetDefault("http.handler_timeout", 8*time.Second)
	v.SetDefault("http.idle_timeout", time.Minute)
	v.SetDefault("http.shutdown_timeout", 10*time.Second)
	// Same-origin by construction: the binary serves the app it talks to.
	v.SetDefault("http.allowed_origins", []string{})
	v.SetDefault("http.trusted_proxies", []string{})
	// The API surface is not a secret, but publishing it to anonymous visitors is a
	// choice a deployer should make rather than inherit.
	v.SetDefault("http.swagger_enabled", false)
	v.SetDefault("http.max_body_bytes", 8*1024*1024)
	v.SetDefault("http.static_cache_max_age", 365*24*time.Hour)

	v.SetDefault("postgres.host", "localhost")
	v.SetDefault("postgres.port", 5432)
	v.SetDefault("postgres.user", "postgres")
	v.SetDefault("postgres.password", "")
	v.SetDefault("postgres.database", "shelf")
	// Anything but a unix socket or the same host sends credentials in the clear.
	v.SetDefault("postgres.ssl_mode", "prefer")
	v.SetDefault("postgres.max_conns", 10)
	v.SetDefault("postgres.min_conns", 2)
	v.SetDefault("postgres.max_conn_lifetime", 30*time.Minute)
	v.SetDefault("postgres.max_conn_idle_time", 5*time.Minute)
	v.SetDefault("postgres.connect_timeout", 5*time.Second)
	v.SetDefault("postgres.auto_migrate", true)

	v.SetDefault("auth.secret", "")
	v.SetDefault("auth.issuer", "shelf")
	v.SetDefault("auth.access_ttl", 15*time.Minute)
	v.SetDefault("auth.refresh_ttl", 30*24*time.Hour)
	v.SetDefault("auth.recovery_ttl", 10*time.Minute)
	v.SetDefault("auth.argon2.memory", 64*1024)
	v.SetDefault("auth.argon2.iterations", 3)
	v.SetDefault("auth.argon2.parallelism", 2)
	v.SetDefault("auth.argon2.salt_length", 16)
	v.SetDefault("auth.argon2.key_length", 32)

	v.SetDefault("auth.rate_limit.enabled", true)
	v.SetDefault("auth.rate_limit.login_ip.limit", 10)
	v.SetDefault("auth.rate_limit.login_ip.window", 5*time.Minute)
	v.SetDefault("auth.rate_limit.login_account.limit", 20)
	v.SetDefault("auth.rate_limit.login_account.window", 15*time.Minute)
	v.SetDefault("auth.rate_limit.recovery_ip.limit", 5)
	v.SetDefault("auth.rate_limit.recovery_ip.window", 15*time.Minute)
	v.SetDefault("auth.rate_limit.recovery_account.limit", 10)
	v.SetDefault("auth.rate_limit.recovery_account.window", time.Hour)
	v.SetDefault("auth.rate_limit.invite_ip.limit", 20)
	v.SetDefault("auth.rate_limit.invite_ip.window", 15*time.Minute)
	v.SetDefault("auth.rate_limit.share_ip.limit", 60)
	v.SetDefault("auth.rate_limit.share_ip.window", 15*time.Minute)
	v.SetDefault("auth.rate_limit.register_ip.limit", 20)
	v.SetDefault("auth.rate_limit.register_ip.window", time.Hour)

	v.SetDefault("realtime.enabled", true)
	v.SetDefault("realtime.auth_deadline", 5*time.Second)
	v.SetDefault("realtime.reauth_grace", time.Minute)
	v.SetDefault("realtime.ping_interval", 30*time.Second)
	v.SetDefault("realtime.max_conns_per_user", 8)
	v.SetDefault("realtime.max_frame_bytes", 64*1024)
	v.SetDefault("realtime.send_queue", 256)
	// Updates are batched client-side, so ordinary typing produces about four frames a
	// second. The limit is what a stuck loop hits, not what a fast typist hits.
	v.SetDefault("realtime.update_rate.limit", 60)
	v.SetDefault("realtime.update_rate.window", 10*time.Second)

	v.SetDefault("log.level", "debug")
	v.SetDefault("log.format", "console")
}

// bindEnvs recursively registers the environment variables for every struct field
func bindEnvs(v *viper.Viper, cfg any, parts ...string) {
	value := reflect.ValueOf(cfg)
	typ := value.Type()

	for i := range typ.NumField() {
		field := typ.Field(i)

		name := field.Tag.Get("mapstructure")
		if name == "" {
			name = strings.ToLower(field.Name)
		}

		key := append(append([]string{}, parts...), name)

		if field.Type.Kind() == reflect.Struct && field.Type != reflect.TypeOf(time.Time{}) {
			bindEnvs(v, value.Field(i).Interface(), key...)
			continue
		}

		_ = v.BindEnv(strings.Join(key, "."))
	}
}
