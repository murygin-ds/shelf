package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"shelf/internal/mcp"
	"shelf/internal/vault"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

// Path is where the MCP transport lives. One endpoint for every vault: which one a caller
// reaches is decided by the credential it presents, never by the URL, so a leaked path
// grants nothing and a token cannot be pointed somewhere it was not issued for.
const Path = "/mcp"

// maxRequestBody matches the ciphertext ceiling a note body has to fit inside.
const maxRequestBody = 4 << 20

type principalKey struct{}

// Connector is the slice of the connector service the transport drives.
type Connector interface {
	Authenticate(ctx context.Context, secret string) (*mcp.Connector, error)
	Workspace(ctx context.Context, connector *mcp.Connector) (*mcp.Workspace, error)
}

// Transport serves MCP over Streamable HTTP.
type Transport struct {
	connector Connector
	// resource is the URL a client was told to use, echoed in the challenge so an
	// unauthenticated caller can discover where to get a token. It has to match what the
	// person typed into Claude exactly, which is why it is configured rather than derived
	// from the Host header a proxy may have rewritten.
	resource string
	log      *zap.Logger
}

// NewTransport creates the transport.
func NewTransport(connector Connector, publicBaseURL string, log *zap.Logger) *Transport {
	return &Transport{
		connector: connector,
		resource:  strings.TrimSuffix(publicBaseURL, "/"),
		log:       log,
	}
}

// RegisterRoutes mounts the transport outside the bearer middleware the rest of the API
// uses: an MCP credential is not an access token, and the two must not be interchangeable.
func (t *Transport) RegisterRoutes(rg *gin.RouterGroup) {
	handler := sdk.NewStreamableHTTPHandler(t.server, &sdk.StreamableHTTPOptions{
		MaxRequestBodyBytes: maxRequestBody,
	})

	rg.Any(Path, t.authenticate, gin.WrapH(handler))
}

// authenticate resolves the credential before the protocol sees the request.
//
// An unauthenticated call is answered with 401 and a pointer to the metadata that says where
// to get a token. The status matters: a challenge on a 200 is ignored, and the connection
// then fails with nothing to go on.
func (t *Transport) authenticate(c *gin.Context) {
	secret, ok := bearer(c.GetHeader("Authorization"))
	if !ok {
		t.challenge(c, "a bearer credential is required")

		return
	}

	connector, err := t.connector.Authenticate(c.Request.Context(), secret)
	if err != nil {
		t.challenge(c, "the credential is not valid for any vault")

		return
	}

	ctx := context.WithValue(c.Request.Context(), principalKey{}, connector)
	c.Request = c.Request.WithContext(ctx)

	c.Next()
}

func (t *Transport) challenge(c *gin.Context, reason string) {
	if t.resource != "" {
		c.Header("WWW-Authenticate", fmt.Sprintf(
			`Bearer resource_metadata=%q`, t.resource+"/.well-known/oauth-protected-resource"))
	}

	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": gin.H{
		"code": "unauthorized", "message": reason,
	}})
}

// server builds the tools for one request, bound to the vault the credential named.
//
// Per request rather than once: the workspace holds decrypted keys, and a connector removed
// a moment ago must not be served out of something built before it was.
func (t *Transport) server(r *http.Request) *sdk.Server {
	server := sdk.NewServer(&sdk.Implementation{Name: "shelf", Version: "1"}, nil)

	connector, _ := r.Context().Value(principalKey{}).(*mcp.Connector)
	if connector == nil {
		return server
	}

	t.register(server, connector)

	return server
}

func bearer(header string) (string, bool) {
	const prefix = "Bearer "

	if len(header) <= len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}

	secret := strings.TrimSpace(header[len(prefix):])

	return secret, secret != ""
}

// open prepares the workspace a tool call works through. Every call does it again, so that
// a rotation or a revocation lands on the next call rather than on the next restart.
func (t *Transport) open(ctx context.Context, connector *mcp.Connector) (*mcp.Workspace, error) {
	workspace, err := t.connector.Workspace(ctx, connector)
	if err != nil {
		if errors.Is(err, vault.ErrNotFound) {
			return nil, fmt.Errorf("this connector no longer has access to its vault")
		}

		return nil, err
	}

	return workspace, nil
}

// toolError turns a domain failure into something a model can act on rather than retry
// blindly. A conflict in particular has to say what to do about it.
func toolError(err error) error {
	switch {
	case errors.Is(err, vault.ErrVersionConflict):
		return fmt.Errorf("%w — read the note again and reapply your change to the current text", err)
	case errors.Is(err, mcp.ErrBusy):
		return fmt.Errorf("%w — somebody has it open in the editor; try again shortly", err)
	case errors.Is(err, mcp.ErrLocked):
		return fmt.Errorf("%w — this part of the vault is sealed with a key the connector was not given", err)
	case errors.Is(err, vault.ErrScopeMismatch):
		return errors.New("that folder is sealed with a different key, so the note would be " +
			"unreadable there — leave it where it is")
	case errors.Is(err, mcp.ErrTooLarge), errors.Is(err, mcp.ErrPath):
		// Already phrased for the caller; wrapping would only bury it.
		return err
	case errors.Is(err, vault.ErrForbidden):
		return errors.New("the connector is not allowed to change that")
	case errors.Is(err, vault.ErrNotFound):
		return errors.New("no such note or folder in this vault")
	default:
		return err
	}
}

// logged reports a failure without ever putting a note's contents in the log.
func (t *Transport) logged(tool string, connector *mcp.Connector, err error) error {
	t.log.Warn("mcp tool failed",
		zap.String("tool", tool),
		zap.Int64("vault_id", connector.VaultID),
		zap.String("reason", err.Error()),
	)

	return toolError(err)
}
