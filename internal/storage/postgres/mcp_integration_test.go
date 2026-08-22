//go:build integration

// The connector is the one subject this server holds a key for, and the argument for making
// it an ordinary account rather than a subject type of its own is that rotation, revocation
// and the permission model then carry it for free. That argument is only worth as much as
// this file proves.
//
//	SHELF_TEST_POSTGRES_DSN=postgres://user@localhost:5432/shelf_test?sslmode=disable \
//	    go test -tags integration ./internal/storage/postgres/
package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"testing"

	"shelf/internal/envelope"
	"shelf/internal/mcp"
	"shelf/internal/vault"
)

const connectorSecret = "an-integration-test-secret-over-32-chars"

type testHasher struct{}

func (testHasher) Hash(secret []byte) (string, error) {
	sum := sha256.Sum256(secret)

	return "$test$" + hex.EncodeToString(sum[:]), nil
}

// enable runs both halves of turning a connector on, as the API does.
func enable(t *testing.T, f *fixture, repo *MCPRepository) *mcp.Connector {
	t.Helper()

	ctx := context.Background()

	account, err := mcp.NewAccount(connectorSecret, testHasher{})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}

	created, err := repo.Create(ctx, mcp.NewConnector{
		VaultID:   f.vaultID,
		EnabledBy: f.ownerID,
		Role:      vault.RoleEditor,
		Account:   *account,
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	if created.Admitted() {
		t.Fatal("a connector was readable before it was handed a key")
	}

	sealPublic, _, err := envelope.SplitPublicBlob(created.PublicKey)
	if err != nil {
		t.Fatalf("SplitPublicBlob: %v", err)
	}

	scopeKey := make([]byte, envelope.KeyLength)
	for i := range scopeKey {
		scopeKey[i] = byte(i)
	}

	box, err := envelope.Seal(sealPublic, scopeKey, envelope.SealInfo(f.scopeClientID(), 1))
	if err != nil {
		t.Fatalf("Seal: %v", err)
	}

	admitted, err := repo.Admit(ctx, f.vaultID, f.ownerID, []mcp.SealedKey{{
		ScopeID:    f.scopeID,
		KeyVersion: 1,
		WrappedKey: box.Blob,
		Nonce:      box.Nonce,
	}})
	if err != nil {
		t.Fatalf("Admit: %v", err)
	}

	if !admitted.Admitted() {
		t.Fatal("a connector handed its key is still pending")
	}

	return admitted
}

func (f *fixture) scopeClientID() string {
	f.t.Helper()

	var clientID string

	err := f.pool.QueryRow(context.Background(),
		`SELECT client_id::TEXT FROM key_scopes WHERE id = $1`, f.scopeID).Scan(&clientID)
	if err != nil {
		f.t.Fatalf("read scope client id: %v", err)
	}

	return clientID
}

func TestConnectorIsEnabledInOneTransaction(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	repo := NewMCPRepository(pool, nil)
	ctx := context.Background()

	connector := enable(t, f, repo)

	// The account, the membership and the connector row are one act, so all three exist or
	// none do.
	var members, connectors, grants int

	rows := []struct {
		query string
		into  *int
		what  string
	}{
		{`SELECT count(*) FROM vault_members WHERE vault_id = $1 AND user_id = $2`, &members, "membership"},
		{`SELECT count(*) FROM vault_mcp WHERE vault_id = $1 AND connector_user_id = $2`, &connectors, "connector row"},
		{`SELECT count(*) FROM key_grants kg
		    JOIN key_scopes ks ON ks.id = kg.scope_id
		   WHERE ks.vault_id = $1 AND kg.subject_type = 'user' AND kg.subject_id = $2`, &grants, "key grant"},
	}

	for _, row := range rows {
		if err := pool.QueryRow(ctx, row.query, f.vaultID, connector.UserID).Scan(row.into); err != nil {
			t.Fatalf("count %s: %v", row.what, err)
		}
	}

	if members != 1 || connectors != 1 || grants != 1 {
		t.Fatalf("membership=%d connector=%d grants=%d, want one of each", members, connectors, grants)
	}

	// Asking twice must not mint a second account: the browser may need the public key more
	// than once before it manages to seal to it.
	again, err := repo.Create(ctx, mcp.NewConnector{
		VaultID: f.vaultID, EnabledBy: f.ownerID, Role: vault.RoleEditor,
		Account: mustAccount(t),
	})
	if err != nil {
		t.Fatalf("Create twice: %v", err)
	}

	if again.UserID != connector.UserID {
		t.Errorf("a second account was minted: %d then %d", connector.UserID, again.UserID)
	}
}

// The grant has to come back in the shape the keyring opens, and it has to open with the
// identity recovered from the row rather than with anything held in memory.
func TestConnectorGrantsOpenWithTheStoredIdentity(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	repo := NewMCPRepository(pool, nil)
	ctx := context.Background()

	enable(t, f, repo)

	keys, err := repo.Keys(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("Keys: %v", err)
	}

	identity, err := mcp.OpenIdentity(connectorSecret, keys)
	if err != nil {
		t.Fatalf("OpenIdentity: %v", err)
	}

	grants, err := repo.Grants(ctx, f.vaultID)
	if err != nil {
		t.Fatalf("Grants: %v", err)
	}

	if len(grants) != 1 {
		t.Fatalf("got %d grants, want 1", len(grants))
	}

	grant := grants[0]

	opened, err := envelope.Open(identity.Seal,
		envelope.Box{Blob: grant.WrappedKey, Nonce: grant.Nonce},
		envelope.SealInfo(grant.ScopeClientID, grant.KeyVersion))
	if err != nil {
		t.Fatalf("open the granted scope key: %v", err)
	}

	if len(opened) != envelope.KeyLength {
		t.Errorf("the scope key came back %d bytes", len(opened))
	}

	if grant.Algorithm != "ecdh-p256-hkdf-a256gcm" {
		t.Errorf("grant algorithm is %q", grant.Algorithm)
	}
}

// A scope belonging to another vault must not be reachable through this call, or a caller
// could address the connector with a key it has no business holding.
func TestConnectorRefusesAForeignScope(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	other := seed(t, pool, vault.RoleOwner)
	repo := NewMCPRepository(pool, nil)
	ctx := context.Background()

	account, err := mcp.NewAccount(connectorSecret, testHasher{})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}

	if _, err := repo.Create(ctx, mcp.NewConnector{
		VaultID: f.vaultID, EnabledBy: f.ownerID, Role: vault.RoleEditor, Account: *account,
	}); err != nil {
		t.Fatalf("Create: %v", err)
	}

	_, err = repo.Admit(ctx, f.vaultID, f.ownerID, []mcp.SealedKey{{
		ScopeID: other.scopeID, KeyVersion: 1, WrappedKey: []byte{1}, Nonce: []byte{2},
	}})

	if !errors.Is(err, vault.ErrScopeMismatch) {
		t.Fatalf("admitting a foreign scope returned %v, want ErrScopeMismatch", err)
	}
}

// The whole reason the connector is an account: rotation finds it without being told.
func TestRotationCarriesTheConnector(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	repo := NewMCPRepository(pool, nil)
	ctx := context.Background()

	connector := enable(t, f, repo)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}

	defer func() { _ = tx.Rollback(ctx) }()

	subjects, err := rekeySubjects(ctx, tx, f.vaultID, vault.ScopeVault, f.vaultID, f.scopeID, false)
	if err != nil {
		t.Fatalf("rekeySubjects: %v", err)
	}

	var found *vault.RekeySubject

	for i := range subjects {
		if subjects[i].UserID == connector.UserID {
			found = &subjects[i]

			break
		}
	}

	if found == nil {
		t.Fatal("rotation did not list the connector among the key holders")
	}

	// The plan carries the public key the browser re-seals to, so it has to be the real
	// blob rather than a placeholder.
	if _, _, err := envelope.SplitPublicBlob(found.PublicKey); err != nil {
		t.Errorf("the connector went into the plan with an unusable public key: %v", err)
	}
}

// Revocation is the existing member removal, and it has to take the key grants with it.
func TestRemovingTheConnectorTakesItsKeys(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	repo := NewMCPRepository(pool, nil)
	ctx := context.Background()

	connector := enable(t, f, repo)

	access := NewAccessRepository(pool, nil)

	if _, err := access.RemoveMember(ctx, f.vaultID, connector.UserID, f.ownerID); err != nil {
		t.Fatalf("RemoveMember: %v", err)
	}

	var grants int

	err := pool.QueryRow(ctx,
		`SELECT count(*) FROM key_grants WHERE subject_type = 'user' AND subject_id = $1`,
		connector.UserID).Scan(&grants)
	if err != nil {
		t.Fatalf("count grants: %v", err)
	}

	if grants != 0 {
		t.Errorf("%d key grants survived the removal", grants)
	}

	// The connector row hangs off the membership by a composite foreign key, so removing the
	// member is the whole of turning the connector off. If this ever stops holding, disabling
	// becomes two transactions that can disagree.
	var connectors int

	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM vault_mcp WHERE vault_id = $1`, f.vaultID).Scan(&connectors); err != nil {
		t.Fatalf("count connector rows: %v", err)
	}

	if connectors != 0 {
		t.Error("the connector row survived the removal of its membership")
	}

	if _, err := repo.Connector(ctx, f.vaultID); !errors.Is(err, mcp.ErrNotFound) {
		t.Errorf("reading a removed connector returned %v, want ErrNotFound", err)
	}
}

func mustAccount(t *testing.T) mcp.Account {
	t.Helper()

	account, err := mcp.NewAccount(connectorSecret, testHasher{})
	if err != nil {
		t.Fatalf("NewAccount: %v", err)
	}

	return *account
}
