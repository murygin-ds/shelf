package mcp

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"time"
)

// The kinds of credential a connector can hold.
const (
	// KindStatic is a fixed header a person pastes into a client. It exists for the local
	// case: a server on localhost is unreachable from Anthropic's network, and this is what
	// makes the connector testable before it is exposed to the internet at all.
	KindStatic = "static"
	// KindAccess and KindRefresh are what the OAuth flow issues.
	KindAccess  = "access"
	KindRefresh = "refresh"
)

// tokenBytes is the entropy behind one credential. The same 32 bytes a session refresh
// token carries, for the same reason: it is the whole of the secret.
const tokenBytes = 32

// TokenTTL bounds each kind. An access token is short because revoking one means waiting
// for it to lapse; a refresh token is long because it is rotated on every use.
const (
	AccessTTL  = time.Hour
	RefreshTTL = 30 * 24 * time.Hour
	StaticTTL  = 365 * 24 * time.Hour
)

// Token is an issued credential, as stored. The secret itself is never here: the database
// holds its digest, exactly as the sessions table does.
type Token struct {
	ID        int64
	VaultID   int64
	UserID    int64
	ClientID  *int64
	Kind      string
	Label     string
	ChainID   *int64
	ExpiresAt time.Time
}

// NewToken is a credential about to be written.
type NewToken struct {
	VaultID   int64
	UserID    int64
	ClientID  *int64
	Kind      string
	Label     string
	ChainID   *int64
	Hash      []byte
	ExpiresAt time.Time
}

// Issued is a freshly minted credential. The Secret is the only time it exists in the clear.
type Issued struct {
	Token
	Secret string
}

// Tokens stores the connector's credentials.
type Tokens interface {
	IssueToken(ctx context.Context, in NewToken) (*Token, error)
	// TokenByHash resolves a credential that is neither expired nor revoked.
	TokenByHash(ctx context.Context, hash []byte, kind string) (*Token, error)
	// SpendRefresh consumes a refresh token exactly once. A second attempt reports
	// ErrTokenReplayed and takes the whole rotation chain with it — the theft it implies is
	// worth more than the session it costs. Unlike the browser's sessions, the damage stops
	// at this connector.
	SpendRefresh(ctx context.Context, hash []byte) (*Token, error)
	RevokeVaultTokens(ctx context.Context, vaultID int64) error
	Credentials(ctx context.Context, vaultID int64) ([]TokenSummary, error)
}

// TokenSummary is what the UI lists: enough to recognise a credential and revoke it, never
// enough to use one.
type TokenSummary struct {
	ID         int64
	Kind       string
	Label      string
	CreatedAt  time.Time
	LastUsedAt *time.Time
	ExpiresAt  time.Time
}

// ErrTokenReplayed reports a refresh token presented after it was already spent.
var ErrTokenReplayed = fmt.Errorf("this credential was already used")

// mint generates a credential and returns it with its digest.
func mint() (secret string, hash []byte, err error) {
	raw := make([]byte, tokenBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", nil, fmt.Errorf("read token: %w", err)
	}

	secret = base64.RawURLEncoding.EncodeToString(raw)
	digest := sha256.Sum256([]byte(secret))

	return secret, digest[:], nil
}

// Digest is how a presented credential is looked up. Hashing before the query is what keeps
// a database dump from being a list of working credentials.
func Digest(secret string) []byte {
	sum := sha256.Sum256([]byte(secret))

	return sum[:]
}

// IssueStatic mints the fixed credential a local client carries in a header.
func (s *Service) IssueStatic(ctx context.Context, actorID, vaultID int64, label string) (*Issued, error) {
	if err := s.owner(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	connector, err := s.repo.Connector(ctx, vaultID)
	if err != nil {
		return nil, err
	}

	if !connector.Admitted() {
		return nil, fmt.Errorf("%w: the connector has no key yet", ErrNotFound)
	}

	return s.issue(ctx, NewToken{
		VaultID:   vaultID,
		UserID:    connector.UserID,
		Kind:      KindStatic,
		Label:     label,
		ExpiresAt: time.Now().Add(StaticTTL),
	})
}

// Credentials lists what is outstanding for a vault, so a person can see and revoke it.
func (s *Service) Credentials(ctx context.Context, actorID, vaultID int64) ([]TokenSummary, error) {
	if err := s.owner(ctx, vaultID, actorID); err != nil {
		return nil, err
	}

	return s.tokens.Credentials(ctx, vaultID)
}

// RevokeCredentials drops every credential on a vault without touching the key grant, which
// is the difference between "sign Claude out" and "take the key away".
func (s *Service) RevokeCredentials(ctx context.Context, actorID, vaultID int64) error {
	if err := s.owner(ctx, vaultID, actorID); err != nil {
		return err
	}

	return s.tokens.RevokeVaultTokens(ctx, vaultID)
}

// Authenticate resolves a presented credential to the connector it speaks for.
//
// Both kinds land here, and neither is trusted further than the row it matched: an expired
// or revoked credential simply does not resolve, and a connector removed since it was issued
// has no membership left for the workspace to open.
func (s *Service) Authenticate(ctx context.Context, secret string) (*Connector, error) {
	digest := Digest(secret)

	for _, kind := range []string{KindAccess, KindStatic} {
		token, err := s.tokens.TokenByHash(ctx, digest, kind)
		if err != nil {
			continue
		}

		return s.repo.Connector(ctx, token.VaultID)
	}

	return nil, ErrNotFound
}

func (s *Service) issue(ctx context.Context, in NewToken) (*Issued, error) {
	secret, hash, err := mint()
	if err != nil {
		return nil, err
	}

	in.Hash = hash

	token, err := s.tokens.IssueToken(ctx, in)
	if err != nil {
		return nil, err
	}

	return &Issued{Token: *token, Secret: secret}, nil
}
