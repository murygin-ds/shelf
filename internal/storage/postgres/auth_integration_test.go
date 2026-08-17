//go:build integration

// Account deletion is the one statement here the schema can refuse: vaults.owner_id is
// ON DELETE RESTRICT, so the order the rows go in is the whole of the logic. A fake
// repository would answer whatever it was written to answer, which is why this runs
// against the real migrations.
//
//	SHELF_TEST_POSTGRES_DSN=postgres://user@localhost:5432/shelf_test?sslmode=disable \
//	    go test -tags integration ./internal/storage/postgres/
package postgres

import (
	"context"
	"errors"
	"testing"

	"shelf/internal/auth"
	"shelf/internal/vault"
)

func TestDeleteUserTakesTheVaultsItOwns(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	repo := NewAuthRepository(pool)
	ctx := context.Background()

	if err := repo.DeleteUser(ctx, f.ownerID); err != nil {
		t.Fatalf("DeleteUser(owner) error = %v", err)
	}

	if _, err := repo.UserByID(ctx, f.ownerID); !errors.Is(err, auth.ErrUserNotFound) {
		t.Errorf("UserByID(owner) error = %v, want ErrUserNotFound", err)
	}

	var vaults int

	if err := pool.QueryRow(ctx, `SELECT count(*) FROM vaults WHERE id = $1`, f.vaultID).Scan(&vaults); err != nil {
		t.Fatalf("count vaults: %v", err)
	}

	if vaults != 0 {
		t.Errorf("vaults left = %d, want the owned vault gone with its owner", vaults)
	}

	// The member is somebody else's account and stays whole; only their seat is gone.
	if _, err := repo.UserByID(ctx, f.userID); err != nil {
		t.Errorf("UserByID(member) error = %v, want the other account untouched", err)
	}
}

func TestDeleteUserLeavesSomebodyElsesVault(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	repo := NewAuthRepository(pool)
	ctx := context.Background()

	if err := repo.DeleteUser(ctx, f.userID); err != nil {
		t.Fatalf("DeleteUser(member) error = %v", err)
	}

	var vaults, members int

	if err := pool.QueryRow(ctx, `SELECT count(*) FROM vaults WHERE id = $1`, f.vaultID).Scan(&vaults); err != nil {
		t.Fatalf("count vaults: %v", err)
	}

	if vaults != 1 {
		t.Errorf("vaults left = %d, want the owner's vault standing", vaults)
	}

	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM vault_members WHERE vault_id = $1 AND user_id = $2`,
		f.vaultID, f.userID,
	).Scan(&members)
	if err != nil {
		t.Fatalf("count memberships: %v", err)
	}

	if members != 0 {
		t.Errorf("memberships left = %d, want the seat released", members)
	}
}

func TestUpdateDisplayName(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleEditor)
	repo := NewAuthRepository(pool)
	ctx := context.Background()

	updated, err := repo.UpdateDisplayName(ctx, f.userID, "Dmitry M.")
	if err != nil {
		t.Fatalf("UpdateDisplayName() error = %v", err)
	}

	if updated.DisplayName != "Dmitry M." {
		t.Errorf("display name = %q, want %q", updated.DisplayName, "Dmitry M.")
	}

	if _, err := repo.UpdateDisplayName(ctx, f.userID+10_000, "Nobody"); !errors.Is(err, auth.ErrUserNotFound) {
		t.Errorf("UpdateDisplayName(missing) error = %v, want ErrUserNotFound", err)
	}
}
