package mcp

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.uber.org/zap"
)

// The OAuth errors, named as RFC 6749 names them. The codes matter: Claude refreshes on a
// 401 and gives up on anything that is not invalid_grant, so a spent code reported as
// invalid_request looks like a broken server rather than an expired credential.
var (
	ErrInvalidGrant   = errors.New("invalid_grant")
	ErrInvalidClient  = errors.New("invalid_client")
	ErrInvalidRequest = errors.New("invalid_request")
)

// codeTTL is deliberately short. A code is exchanged within a redirect, and anything longer
// is a window somebody else can use it in.
const codeTTL = 60 * time.Second

// Client is an OAuth client. Every one of them is public: Claude registers itself on a fresh
// connection and holds no secret, so PKCE is what stands in for one.
type Client struct {
	ID           int64
	ClientID     string
	Name         string
	RedirectURIs []string
	CreatedAt    time.Time
}

// NewClient is a registration about to be written.
type NewClient struct {
	ClientID     string
	Name         string
	RedirectURIs []string
}

// NewCode is an authorization code about to be written. Only its digest is stored.
type NewCode struct {
	Hash          []byte
	ClientID      int64
	VaultID       int64
	UserID        int64
	RedirectURI   string
	CodeChallenge string
	Scope         string
	ExpiresAt     time.Time
}

// Code is a redeemed authorization code.
type Code struct {
	ClientID      int64
	VaultID       int64
	UserID        int64
	RedirectURI   string
	CodeChallenge string
	Scope         string
}

// Grant is what a token exchange hands back.
type Grant struct {
	AccessToken  string
	RefreshToken string
	ExpiresIn    int
	Scope        string
}

// OAuth stores the clients and the codes.
type OAuth interface {
	RegisterClient(ctx context.Context, in NewClient) (*Client, error)
	ClientByID(ctx context.Context, clientID string) (*Client, error)
	IssueCode(ctx context.Context, in NewCode) error
	// SpendCode consumes a code exactly once. A second attempt is a leak, not a retry.
	SpendCode(ctx context.Context, hash []byte) (*Code, error)
}

// RegisterClient records a dynamic registration.
//
// Unauthenticated by design — that is what dynamic registration is — so it is rate limited
// at the edge and the row it writes grants nothing on its own.
func (s *Service) RegisterClient(ctx context.Context, name string, redirects []string) (*Client, error) {
	if len(redirects) == 0 {
		return nil, fmt.Errorf("%w: at least one redirect_uri is required", ErrInvalidRequest)
	}

	for _, raw := range redirects {
		if err := usableRedirect(raw); err != nil {
			return nil, err
		}
	}

	return s.oauth.RegisterClient(ctx, NewClient{
		ClientID:     uuid.NewString(),
		Name:         name,
		RedirectURIs: redirects,
	})
}

// Client resolves a registration for the consent screen, which has to show who is asking.
func (s *Service) Client(ctx context.Context, clientID string) (*Client, error) {
	client, err := s.oauth.ClientByID(ctx, clientID)
	if err != nil {
		return nil, ErrInvalidClient
	}

	return client, nil
}

// Authorize records a person's consent as a one-time code.
//
// The person consenting must own the vault: agreeing that this server may read a vault is
// the same decision as connecting it, and it is not one a reader gets to make on the
// owner's behalf.
func (s *Service) Authorize(
	ctx context.Context,
	actorID, vaultID int64,
	clientID, redirectURI, challenge string,
) (string, error) {
	if err := s.owner(ctx, vaultID, actorID); err != nil {
		return "", err
	}

	connector, err := s.repo.Connector(ctx, vaultID)
	if err != nil {
		return "", err
	}

	if !connector.Admitted() {
		return "", fmt.Errorf("%w: the connector has no key yet", ErrNotFound)
	}

	client, err := s.Client(ctx, clientID)
	if err != nil {
		return "", err
	}

	// Checked again rather than trusted from the row: registration is unauthenticated, this
	// is the step that turns a redirect into a place an authorization code is sent, and a
	// row written before this check existed must not become one.
	if err := usableRedirect(redirectURI); err != nil {
		return "", err
	}

	if !allowedRedirect(client.RedirectURIs, redirectURI) {
		return "", fmt.Errorf("%w: redirect_uri is not registered for this client", ErrInvalidRequest)
	}

	if challenge == "" {
		return "", fmt.Errorf("%w: a S256 code_challenge is required", ErrInvalidRequest)
	}

	secret, hash, err := mint()
	if err != nil {
		return "", err
	}

	err = s.oauth.IssueCode(ctx, NewCode{
		Hash:          hash,
		ClientID:      client.ID,
		VaultID:       vaultID,
		UserID:        connector.UserID,
		RedirectURI:   redirectURI,
		CodeChallenge: challenge,
		Scope:         scopeFor(connector),
		ExpiresAt:     time.Now().Add(codeTTL),
	})
	if err != nil {
		return "", err
	}

	return secret, nil
}

// Exchange turns a code into tokens, once.
func (s *Service) Exchange(ctx context.Context, clientID, code, verifier, redirectURI string) (*Grant, error) {
	client, err := s.Client(ctx, clientID)
	if err != nil {
		return nil, err
	}

	spent, err := s.oauth.SpendCode(ctx, Digest(code))
	if err != nil {
		return nil, ErrInvalidGrant
	}

	if spent.ClientID != client.ID {
		return nil, ErrInvalidGrant
	}

	// The redirect is part of what the code was issued against: without the check, a code
	// intercepted at one registered redirect could be redeemed by naming another.
	if redirectURI != "" && redirectURI != spent.RedirectURI {
		return nil, ErrInvalidGrant
	}

	if !verifies(verifier, spent.CodeChallenge) {
		return nil, ErrInvalidGrant
	}

	return s.grant(ctx, spent.VaultID, spent.UserID, &client.ID, nil, spent.Scope)
}

// Refresh rotates a refresh token. The old one is spent whether or not this succeeds, which
// is what makes a stolen token worth only one use.
func (s *Service) Refresh(ctx context.Context, clientID, refresh string) (*Grant, error) {
	client, err := s.Client(ctx, clientID)
	if err != nil {
		return nil, err
	}

	spent, err := s.tokens.SpendRefresh(ctx, Digest(refresh))
	if err != nil {
		if errors.Is(err, ErrTokenReplayed) {
			s.log.Warn("a connector refresh token was replayed, its chain is revoked",
				zap.String("client_id", client.ClientID))
		}

		return nil, ErrInvalidGrant
	}

	if spent.ClientID == nil || *spent.ClientID != client.ID {
		return nil, ErrInvalidGrant
	}

	connector, err := s.repo.Connector(ctx, spent.VaultID)
	if err != nil {
		return nil, ErrInvalidGrant
	}

	return s.grant(ctx, spent.VaultID, spent.UserID, &client.ID, spent.ChainID, scopeFor(connector))
}

// grant issues the pair. The refresh token carries the chain, so a replay of any link burns
// the whole rotation rather than one token.
func (s *Service) grant(ctx context.Context, vaultID, userID int64, clientID, chain *int64, scope string) (*Grant, error) {
	access, err := s.issue(ctx, NewToken{
		VaultID: vaultID, UserID: userID, ClientID: clientID, Kind: KindAccess,
		ExpiresAt: time.Now().Add(AccessTTL),
	})
	if err != nil {
		return nil, err
	}

	refresh, err := s.issue(ctx, NewToken{
		VaultID: vaultID, UserID: userID, ClientID: clientID, Kind: KindRefresh, ChainID: chain,
		ExpiresAt: time.Now().Add(RefreshTTL),
	})
	if err != nil {
		return nil, err
	}

	return &Grant{
		AccessToken:  access.Secret,
		RefreshToken: refresh.Secret,
		ExpiresIn:    int(AccessTTL.Seconds()),
		Scope:        scope,
	}, nil
}

// The scopes advertised and granted. They describe what the connector's membership already
// allows rather than adding anything: a viewer's token cannot be widened by asking for more.
const (
	ScopeRead  = "shelf:read"
	ScopeWrite = "shelf:write"
	// ScopeOffline is what makes Claude ask for a refresh token at all.
	ScopeOffline = "offline_access"
)

func scopeFor(connector *Connector) string {
	if connector.Role == "editor" {
		return strings.Join([]string{ScopeRead, ScopeWrite, ScopeOffline}, " ")
	}

	return strings.Join([]string{ScopeRead, ScopeOffline}, " ")
}

// verifies checks PKCE S256. Only S256: "plain" would let anybody who saw the challenge
// redeem the code, which is the attack PKCE exists to stop.
func verifies(verifier, challenge string) bool {
	if verifier == "" || challenge == "" {
		return false
	}

	sum := sha256.Sum256([]byte(verifier))
	expected := base64.RawURLEncoding.EncodeToString(sum[:])

	return subtle.ConstantTimeCompare([]byte(expected), []byte(challenge)) == 1
}

// usableRedirect refuses anything a browser would not treat as a navigation to another site.
//
// This is the load-bearing check of the whole flow. Registration takes no credential, the
// consent screen navigates to whatever comes back, and the authorization code rides in the
// query — so a scheme like javascript: or data: is script running on the vault's own origin,
// and any other host is the code handed to somebody else. Two schemes are allowed: https
// anywhere, and http on the loopback, which is the only way a native client can receive a
// redirect at all.
func usableRedirect(raw string) error {
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("%w: %q is not a redirect_uri", ErrInvalidRequest, raw)
	}

	if parsed.Fragment != "" || strings.Contains(raw, "#") {
		return fmt.Errorf("%w: a redirect_uri may not carry a fragment", ErrInvalidRequest)
	}

	switch {
	case parsed.Scheme == "https" && parsed.Host != "":
		return nil
	case parsed.Scheme == "http" && loopback(parsed):
		return nil
	default:
		return fmt.Errorf(
			"%w: a redirect_uri must be https, or http on the loopback; %q is neither",
			ErrInvalidRequest, raw)
	}
}

// allowedRedirect matches a redirect against what the client registered.
//
// Exact, except for loopback: a native client binds an ephemeral port it cannot know in
// advance, so RFC 8252 requires the port to be ignored there. Claude Code is such a client,
// and without this it cannot complete the flow at all.
func allowedRedirect(registered []string, candidate string) bool {
	parsed, err := url.Parse(candidate)
	if err != nil {
		return false
	}

	for _, raw := range registered {
		if raw == candidate {
			return true
		}

		known, err := url.Parse(raw)
		if err != nil {
			continue
		}

		if loopback(known) && loopback(parsed) &&
			known.Hostname() == parsed.Hostname() && known.Path == parsed.Path {
			return true
		}
	}

	return false
}

func loopback(u *url.URL) bool {
	host := u.Hostname()

	return u.Scheme == "http" && (host == "localhost" || host == "127.0.0.1" || host == "::1")
}
