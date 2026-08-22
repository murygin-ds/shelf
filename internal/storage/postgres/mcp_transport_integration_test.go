//go:build integration

// The transport and the OAuth flow, driven the way Claude drives them: a real HTTP server,
// the SDK's own client over Streamable HTTP, and the authorization code exchange with PKCE.
// Nothing here mocks the protocol, because the protocol is the part most likely to be wrong.
package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	mcpapi "shelf/internal/api/v1/mcp"
	"shelf/internal/config"
	"shelf/internal/mcp"
	"shelf/internal/vault"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// connected is a vault with a connector holding its key, plus the pieces to serve it.
type connected struct {
	service   *mcp.Service
	connector *mcp.Connector
	fixture   *fixture
}

func serve(t *testing.T, f *fixture) *connected {
	t.Helper()

	repo := NewMCPRepository(f.pool, nil)
	connector := enable(t, f, repo)

	store := NewVaultRepository(f.pool, nil)
	vaults := vault.NewService(vault.Deps{
		Vaults: store, Folders: store, Files: store, Tree: store, Sync: store,
		Rekeys: store, Audit: store, Graph: store, Revisions: store, Shares: store,
		CRDT: store, Logger: zap.NewNop(),
	})

	access := NewAccessRepository(f.pool, nil)

	service := mcp.NewService(mcp.Deps{
		Repo: repo, Tokens: repo, OAuth: repo,
		Members: access, Remover: access, Vaults: vaults,
		Hasher: testHasher{},
		Config: config.MCP{Enabled: true, Secret: connectorSecret, PublicBaseURL: "https://shelf.test"},
		Logger: zap.NewNop(),
	})

	return &connected{service: service, connector: connector, fixture: f}
}

// router mounts exactly what the real one mounts for a connector.
func (c *connected) router(t *testing.T) http.Handler {
	t.Helper()

	gin.SetMode(gin.TestMode)

	engine := gin.New()
	api := engine.Group("/api")
	group := api.Group("/v1")

	mcpapi.NewTransport(c.service, "https://shelf.test", zap.NewNop()).RegisterRoutes(group)

	oauth := mcpapi.NewOAuth(c.service, "https://shelf.test", nopLimiter{}, zap.NewNop())
	oauth.RegisterRoutes(group, group)
	oauth.RegisterDiscovery(engine)

	return engine
}

type nopLimiter struct{}

func (nopLimiter) Allow(string) (bool, time.Duration) { return true, 0 }
func (nopLimiter) Refund(string)                      {}

// bearer adds the credential to every request, the way a connector client does.
type bearer struct {
	secret string
	base   http.RoundTripper
}

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	clone := r.Clone(r.Context())
	clone.Header.Set("Authorization", "Bearer "+b.secret)

	return b.base.RoundTrip(clone)
}

func TestMCPTransportChallengesWithoutACredential(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	server := httptest.NewServer(serve(t, f).router(t))

	t.Cleanup(server.Close)

	res, err := http.Post(server.URL+"/api/v1/mcp", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("post: %v", err)
	}

	defer res.Body.Close()

	if res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("an unauthenticated call got %d, want 401", res.StatusCode)
	}

	// The challenge has to point at the metadata, and it has to be on a 401: a client does
	// not read the header off a 200 and gives up with nothing to go on.
	challenge := res.Header.Get("WWW-Authenticate")
	if !strings.Contains(challenge, "resource_metadata=") {
		t.Errorf("challenge is %q, want a resource_metadata pointer", challenge)
	}
}

func TestMCPTransportServesTools(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	c := serve(t, f)
	server := httptest.NewServer(c.router(t))

	t.Cleanup(server.Close)

	ctx := context.Background()

	issued, err := c.service.IssueStatic(ctx, f.ownerID, f.vaultID, "test")
	if err != nil {
		t.Fatalf("IssueStatic: %v", err)
	}

	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil)

	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{
		Endpoint:   server.URL + "/api/v1/mcp",
		HTTPClient: &http.Client{Transport: bearer{secret: issued.Secret, base: http.DefaultTransport}},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}

	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}

	offered := map[string]bool{}
	for _, tool := range tools.Tools {
		offered[tool.Name] = true
	}

	for _, want := range []string{
		"shelf_list_tree", "shelf_read_note", "shelf_search_notes",
		"shelf_create_note", "shelf_write_note", "shelf_append_note", "shelf_trash_note",
	} {
		if !offered[want] {
			t.Errorf("the connector does not offer %s", want)
		}
	}

	// Purging is never offered: it destroys ciphertext nothing brings back.
	if offered["shelf_purge_note"] {
		t.Error("purge is exposed as a tool")
	}

	created, err := session.CallTool(ctx, &sdk.CallToolParams{
		Name:      "shelf_create_note",
		Arguments: map[string]any{"path": "context/stack", "body": "Go and Postgres.\n"},
	})
	if err != nil {
		t.Fatalf("CallTool create: %v", err)
	}

	if created.IsError {
		t.Fatalf("creating a note failed: %+v", created.Content)
	}

	read, err := session.CallTool(ctx, &sdk.CallToolParams{
		Name:      "shelf_read_note",
		Arguments: map[string]any{"path": "context/stack"},
	})
	if err != nil {
		t.Fatalf("CallTool read: %v", err)
	}

	var body struct {
		Body string `json:"body"`
	}

	decode(t, read, &body)

	if body.Body != "Go and Postgres.\n" {
		t.Errorf("the note read back as %q", body.Body)
	}
}

// A viewer is not shown the writing tools at all: a model offered one will try it, and a
// refusal it cannot avoid is worse than the tool not being there.
func TestMCPTransportHidesWritingFromAViewer(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	c := serve(t, f)

	if _, err := c.fixture.pool.Exec(context.Background(),
		`UPDATE vault_members SET role = 'viewer' WHERE vault_id = $1 AND user_id = $2`,
		f.vaultID, c.connector.UserID); err != nil {
		t.Fatalf("demote the connector: %v", err)
	}

	server := httptest.NewServer(c.router(t))
	t.Cleanup(server.Close)

	ctx := context.Background()

	issued, err := c.service.IssueStatic(ctx, f.ownerID, f.vaultID, "viewer")
	if err != nil {
		t.Fatalf("IssueStatic: %v", err)
	}

	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil)

	session, err := client.Connect(ctx, &sdk.StreamableClientTransport{
		Endpoint:   server.URL + "/api/v1/mcp",
		HTTPClient: &http.Client{Transport: bearer{secret: issued.Secret, base: http.DefaultTransport}},
	}, nil)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}

	defer session.Close()

	tools, err := session.ListTools(ctx, nil)
	if err != nil {
		t.Fatalf("ListTools: %v", err)
	}

	for _, tool := range tools.Tools {
		if strings.HasPrefix(tool.Name, "shelf_create") || strings.HasPrefix(tool.Name, "shelf_write") {
			t.Errorf("a viewer is offered %s", tool.Name)
		}
	}
}

func TestOAuthDiscoveryAndCodeFlow(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	c := serve(t, f)
	server := httptest.NewServer(c.router(t))

	t.Cleanup(server.Close)

	// Discovery says what a spec-compliant client checks before it starts.
	var meta struct {
		Issuer                string   `json:"issuer"`
		RegistrationEndpoint  string   `json:"registration_endpoint"`
		ChallengeMethods      []string `json:"code_challenge_methods_supported"`
		ScopesSupported       []string `json:"scopes_supported"`
		TokenEndpointAuthMeth []string `json:"token_endpoint_auth_methods_supported"`
	}

	getJSON(t, server.URL+"/.well-known/oauth-authorization-server", &meta)

	if len(meta.ChallengeMethods) != 1 || meta.ChallengeMethods[0] != "S256" {
		t.Errorf("advertised challenge methods are %v, want [S256]", meta.ChallengeMethods)
	}

	if meta.RegistrationEndpoint == "" {
		t.Error("no registration_endpoint: a client without one falls back to nothing")
	}

	if !contains(meta.ScopesSupported, mcp.ScopeOffline) {
		t.Error("offline_access is not advertised, so no refresh token is ever requested")
	}

	var resource struct {
		Resource string   `json:"resource"`
		Servers  []string `json:"authorization_servers"`
	}

	// The path-suffixed probe has to answer too: it is what a client tries when the
	// challenge carried no pointer.
	getJSON(t, server.URL+"/.well-known/oauth-protected-resource/api/v1/mcp", &resource)

	if resource.Resource != "https://shelf.test/api/v1/mcp" {
		t.Errorf("resource is %q; it must match the URL the person typed", resource.Resource)
	}

	// Register, consent, exchange — the flow as it actually runs.
	var registered struct {
		ClientID string `json:"client_id"`
	}

	postJSON(t, server.URL+"/api/v1/oauth/register", map[string]any{
		"client_name":   "Claude",
		"redirect_uris": []string{"https://claude.ai/api/mcp/auth_callback"},
	}, &registered)

	if registered.ClientID == "" {
		t.Fatal("registration returned no client_id")
	}

	verifier := "a-verifier-long-enough-to-be-a-verifier-0123456789"
	sum := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(sum[:])

	code, err := c.service.Authorize(context.Background(), f.ownerID, f.vaultID,
		registered.ClientID, "https://claude.ai/api/mcp/auth_callback", challenge)
	if err != nil {
		t.Fatalf("Authorize: %v", err)
	}

	form := url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {registered.ClientID},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {"https://claude.ai/api/mcp/auth_callback"},
	}

	var grant struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		TokenType    string `json:"token_type"`
		Scope        string `json:"scope"`
	}

	postForm(t, server.URL+"/api/v1/oauth/token", form, http.StatusOK, &grant)

	if grant.AccessToken == "" || grant.RefreshToken == "" || grant.TokenType != "Bearer" {
		t.Fatalf("the exchange returned %+v", grant)
	}

	if !strings.Contains(grant.Scope, mcp.ScopeWrite) {
		t.Errorf("an editor connector was granted %q", grant.Scope)
	}

	// The access token has to work on the transport it was issued for.
	client := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "1"}, nil)

	session, err := client.Connect(context.Background(), &sdk.StreamableClientTransport{
		Endpoint:   server.URL + "/api/v1/mcp",
		HTTPClient: &http.Client{Transport: bearer{secret: grant.AccessToken, base: http.DefaultTransport}},
	}, nil)
	if err != nil {
		t.Fatalf("connect with an issued token: %v", err)
	}

	session.Close()

	// A code is good once. The second attempt has to be invalid_grant, not a custom code:
	// a client gives up on anything else.
	var failure struct {
		Error string `json:"error"`
	}

	postForm(t, server.URL+"/api/v1/oauth/token", form, http.StatusBadRequest, &failure)

	if failure.Error != "invalid_grant" {
		t.Errorf("a replayed code returned %q, want invalid_grant", failure.Error)
	}
}

func TestOAuthRotatesAndBurnsAReplayedRefresh(t *testing.T) {
	pool := connect(t)
	f := seed(t, pool, vault.RoleOwner)
	c := serve(t, f)
	server := httptest.NewServer(c.router(t))

	t.Cleanup(server.Close)

	ctx := context.Background()

	var registered struct {
		ClientID string `json:"client_id"`
	}

	postJSON(t, server.URL+"/api/v1/oauth/register", map[string]any{
		"client_name":   "Claude",
		"redirect_uris": []string{"http://localhost/callback"},
	}, &registered)

	verifier := "another-verifier-long-enough-0123456789abcdefghij"
	sum := sha256.Sum256([]byte(verifier))

	// A loopback redirect on a port the client picked: RFC 8252 says the port is ignored,
	// and Claude Code cannot complete the flow otherwise.
	code, err := c.service.Authorize(ctx, f.ownerID, f.vaultID, registered.ClientID,
		"http://localhost:53219/callback", base64.RawURLEncoding.EncodeToString(sum[:]))
	if err != nil {
		t.Fatalf("Authorize with a loopback redirect: %v", err)
	}

	var first struct {
		RefreshToken string `json:"refresh_token"`
	}

	postForm(t, server.URL+"/api/v1/oauth/token", url.Values{
		"grant_type":    {"authorization_code"},
		"client_id":     {registered.ClientID},
		"code":          {code},
		"code_verifier": {verifier},
		"redirect_uri":  {"http://localhost:53219/callback"},
	}, http.StatusOK, &first)

	refresh := url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {registered.ClientID},
		"refresh_token": {first.RefreshToken},
	}

	var rotated struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}

	postForm(t, server.URL+"/api/v1/oauth/token", refresh, http.StatusOK, &rotated)

	if rotated.RefreshToken == first.RefreshToken {
		t.Error("the refresh token was not rotated")
	}

	// Presenting the spent one means it leaked, so the chain goes with it.
	var replay struct {
		Error string `json:"error"`
	}

	postForm(t, server.URL+"/api/v1/oauth/token", refresh, http.StatusBadRequest, &replay)

	if replay.Error != "invalid_grant" {
		t.Errorf("a replayed refresh returned %q", replay.Error)
	}

	postForm(t, server.URL+"/api/v1/oauth/token", url.Values{
		"grant_type":    {"refresh_token"},
		"client_id":     {registered.ClientID},
		"refresh_token": {rotated.RefreshToken},
	}, http.StatusBadRequest, &replay)

	if replay.Error != "invalid_grant" {
		t.Error("the rotation chain survived a replay of one of its links")
	}
}

func decode(t *testing.T, result *sdk.CallToolResult, into any) {
	t.Helper()

	raw, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatalf("marshal tool result: %v", err)
	}

	if err := json.Unmarshal(raw, into); err != nil {
		t.Fatalf("decode tool result: %v", err)
	}
}

func getJSON(t *testing.T, url string, into any) {
	t.Helper()

	res, err := http.Get(url)
	if err != nil {
		t.Fatalf("get %s: %v", url, err)
	}

	defer res.Body.Close()

	if res.StatusCode != http.StatusOK {
		t.Fatalf("get %s: %d", url, res.StatusCode)
	}

	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
}

func postJSON(t *testing.T, url string, body, into any) {
	t.Helper()

	raw, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	res, err := http.Post(url, "application/json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatalf("post %s: %v", url, err)
	}

	defer res.Body.Close()

	if res.StatusCode >= http.StatusBadRequest {
		t.Fatalf("post %s: %d", url, res.StatusCode)
	}

	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
}

func postForm(t *testing.T, url string, form url.Values, want int, into any) {
	t.Helper()

	res, err := http.PostForm(url, form)
	if err != nil {
		t.Fatalf("post form %s: %v", url, err)
	}

	defer res.Body.Close()

	if res.StatusCode != want {
		t.Fatalf("post form %s: %d, want %d", url, res.StatusCode, want)
	}

	if err := json.NewDecoder(res.Body).Decode(into); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
}

func contains(list []string, value string) bool {
	for _, item := range list {
		if item == value {
			return true
		}
	}

	return false
}
