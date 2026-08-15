// Package web serves the compiled single page application embedded into the binary.
package web

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"time"
)

// The all: prefix keeps the tracked .gitkeep inside the pattern, so the package still
// compiles in a clone where the frontend has never been built.
//
//go:embed all:dist
var distFS embed.FS

const (
	distDir   = "dist"
	indexFile = "index.html"
	assetsDir = "assets"

	notBuiltMessage = "frontend is not built — run `make web`"
)

// SPA serves the application shell together with the hashed bundle files.
// A request that matches no bundle file resolves to the shell, because routing
// happens on the client.
type SPA struct {
	root        fs.FS
	files       http.Handler
	index       []byte
	assetMaxAge time.Duration
}

// NewSPA reads the embedded bundle. A missing bundle is not fatal: the API stays
// usable and every page request explains how to build the frontend.
func NewSPA(assetMaxAge time.Duration) (*SPA, error) {
	root, err := fs.Sub(distFS, distDir)
	if err != nil {
		return nil, fmt.Errorf("open embedded bundle: %w", err)
	}

	return newSPA(root, assetMaxAge)
}

func newSPA(root fs.FS, assetMaxAge time.Duration) (*SPA, error) {
	spa := &SPA{root: root, files: http.FileServerFS(root), assetMaxAge: assetMaxAge}

	index, err := fs.ReadFile(root, indexFile)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return spa, nil
		}

		return nil, fmt.Errorf("read %s: %w", indexFile, err)
	}

	spa.index = index

	return spa, nil
}

// Built reports whether an actual bundle was embedded.
func (s *SPA) Built() bool { return len(s.index) > 0 }

func (s *SPA) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.Built() {
		http.Error(w, notBuiltMessage, http.StatusServiceUnavailable)
		return
	}

	if name, ok := s.bundleFile(r.URL.Path); ok {
		// Asset names carry a content hash, so the bytes behind one never change.
		if strings.HasPrefix(name, assetsDir+"/") {
			w.Header().Set("Cache-Control", fmt.Sprintf("public, max-age=%d, immutable", int(s.assetMaxAge.Seconds())))
		}

		s.files.ServeHTTP(w, r)

		return
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// The shell references hashed assets, so it must always be revalidated.
	w.Header().Set("Cache-Control", "no-cache")
	// Explicit, because the router reaches this handler through gin's NoRoute,
	// which arrives with the status already set to 404.
	w.WriteHeader(http.StatusOK)

	if r.Method == http.MethodHead {
		return
	}

	_, _ = w.Write(s.index)
}

// bundleFile resolves a URL path to a regular file inside the bundle. The shell is
// excluded so that "/" and "/index.html" take the same branch.
func (s *SPA) bundleFile(urlPath string) (string, bool) {
	name := strings.TrimPrefix(urlPath, "/")
	if name == "" || name == indexFile || !fs.ValidPath(name) {
		return "", false
	}

	info, err := fs.Stat(s.root, name)
	if err != nil || info.IsDir() {
		return "", false
	}

	return name, true
}
