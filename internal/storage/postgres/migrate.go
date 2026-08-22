package postgres

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"

	"shelf/internal/config"
	"shelf/migrations"

	"github.com/golang-migrate/migrate/v4"
	// Registers the driver the DSN below names. It speaks to Postgres through the pgx
	// stack the pool already uses, rather than dragging a second driver into the binary.
	_ "github.com/golang-migrate/migrate/v4/database/pgx/v5"
	"github.com/golang-migrate/migrate/v4/source"
	"github.com/golang-migrate/migrate/v4/source/iofs"
	"go.uber.org/zap"
)

// migrateDriver names the driver registered by the blank import above.
const migrateDriver = "pgx5"

// Migrate brings the database up to the schema this binary was built against.
//
// It is the same tool `make migrate-up` runs, invoked as a library against the migrations
// embedded in the binary, so both paths read and write the same schema_migrations table and
// cannot disagree about where the database stands. Running it here is what makes the
// container self-sufficient: the image has no shell to run a migration tool in, and a
// deployment that needed one more step would be one more step to forget.
//
// Concurrent instances are safe. The driver takes a Postgres advisory lock before touching
// anything, so a second replica starting at the same moment waits and then finds nothing
// left to do.
func Migrate(cfg config.Postgres, log *zap.Logger) error {
	source, err := iofs.New(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}

	dsn, err := url.Parse(cfg.DSN())
	if err != nil {
		return fmt.Errorf("parse postgres dsn: %w", err)
	}

	dsn.Scheme = migrateDriver

	migrator, err := migrate.NewWithSourceInstance("iofs", source, dsn.String())
	if err != nil {
		return fmt.Errorf("open migrator: %w", err)
	}

	defer func() {
		// Close reports the source and the database separately. Neither failure changes
		// what was already applied, so they are logged rather than returned over the top
		// of a migration that succeeded.
		if sourceErr, dbErr := migrator.Close(); sourceErr != nil || dbErr != nil {
			log.Warn("closing the migrator", zap.NamedError("source", sourceErr), zap.NamedError("database", dbErr))
		}
	}()

	before, dirty, err := migrator.Version()
	if err != nil && !errors.Is(err, migrate.ErrNilVersion) {
		return fmt.Errorf("read schema version: %w", err)
	}

	// A database ahead of this binary was migrated by a newer build. Left to itself the
	// migrator reports it as a missing file, which reads like a packaging fault rather than
	// the rollback it actually is.
	newest, err := lastVersion(source)
	if err != nil {
		return fmt.Errorf("read embedded migrations: %w", err)
	}

	if before > newest {
		return fmt.Errorf(
			"database is at schema version %d but this binary only carries %d: it was migrated "+
				"by a newer build, and rolling an image back past a migration is not something "+
				"the schema history supports", before, newest)
	}

	// A migration that failed halfway leaves the version marked dirty, and nothing here can
	// work out how far it got. Starting anyway would run the next migration against a schema
	// that is not the one it was written for.
	if dirty {
		return fmt.Errorf(
			"schema is dirty at version %d: a migration failed halfway, so inspect the database "+
				"and run `make migrate-force version=<n>` once you know where it stands", before)
	}

	switch err := migrator.Up(); {
	case errors.Is(err, migrate.ErrNoChange):
		log.Info("schema is up to date", zap.Uint("version", before))

		return nil
	case err != nil:
		return fmt.Errorf("apply migrations: %w", err)
	}

	after, _, err := migrator.Version()
	if err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}

	log.Info("schema migrated", zap.Uint("from", before), zap.Uint("to", after))

	return nil
}

// lastVersion walks the embedded history to its end. The source driver exposes no count, and
// the answer is only wanted to tell a rollback apart from a missing file.
func lastVersion(driver source.Driver) (uint, error) {
	version, err := driver.First()
	if err != nil {
		return 0, fmt.Errorf("read the first migration: %w", err)
	}

	for {
		next, err := driver.Next(version)

		switch {
		case errors.Is(err, fs.ErrNotExist):
			return version, nil
		case err != nil:
			return 0, fmt.Errorf("walk migrations past version %d: %w", version, err)
		}

		version = next
	}
}
