package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

const (
	indexBody = "<!doctype html><div id=\"root\"></div>"
	assetBody = "console.log(0)"
	assetPath = "assets/index-abc123.js"
)

func newTestSPA(t *testing.T, files fstest.MapFS) *SPA {
	t.Helper()

	spa, err := newSPA(files, 24*time.Hour)
	if err != nil {
		t.Fatalf("new spa: %v", err)
	}

	return spa
}

func bundle() fstest.MapFS {
	return fstest.MapFS{
		indexFile:     {Data: []byte(indexBody)},
		assetPath:     {Data: []byte(assetBody)},
		"favicon.ico": {Data: []byte("icon")},
	}
}

func get(t *testing.T, spa *SPA, path string) *httptest.ResponseRecorder {
	t.Helper()

	rec := httptest.NewRecorder()
	spa.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))

	return rec
}

func TestServesShellForClientRoutes(t *testing.T) {
	t.Parallel()

	spa := newTestSPA(t, bundle())

	for _, path := range []string{"/", "/index.html", "/signin", "/v/7/n/12"} {
		t.Run(path, func(t *testing.T) {
			t.Parallel()

			rec := get(t, spa, path)

			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
			}

			if rec.Body.String() != indexBody {
				t.Fatalf("body = %q, want the shell", rec.Body.String())
			}

			if cache := rec.Header().Get("Cache-Control"); cache != "no-cache" {
				t.Fatalf("Cache-Control = %q, want no-cache", cache)
			}
		})
	}
}

func TestServesBundleFiles(t *testing.T) {
	t.Parallel()

	spa := newTestSPA(t, bundle())

	rec := get(t, spa, "/"+assetPath)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if rec.Body.String() != assetBody {
		t.Fatalf("body = %q, want the asset", rec.Body.String())
	}

	// A hashed name always maps to the same bytes, so the response must be cacheable forever.
	if cache := rec.Header().Get("Cache-Control"); !strings.Contains(cache, "immutable") {
		t.Fatalf("Cache-Control = %q, want an immutable directive", cache)
	}

	// Files outside assets/ keep their name across builds and must not be pinned.
	icon := get(t, spa, "/favicon.ico")
	if icon.Body.String() != "icon" {
		t.Fatalf("favicon body = %q, want the file contents", icon.Body.String())
	}

	if cache := icon.Header().Get("Cache-Control"); strings.Contains(cache, "immutable") {
		t.Fatalf("Cache-Control = %q, want no immutable directive", cache)
	}
}

func TestUnbuiltBundleExplainsItself(t *testing.T) {
	t.Parallel()

	// What a fresh clone embeds: the tracked placeholder and nothing else.
	spa := newTestSPA(t, fstest.MapFS{".gitkeep": {}})

	if spa.Built() {
		t.Fatal("Built() = true, want false without an index.html")
	}

	rec := get(t, spa, "/")
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusServiceUnavailable)
	}

	if !strings.Contains(rec.Body.String(), "make web") {
		t.Fatalf("body = %q, want the build instruction", rec.Body.String())
	}
}

func TestShellOverridesAPresetStatus(t *testing.T) {
	t.Parallel()

	spa := newTestSPA(t, bundle())

	// The router reaches this handler through gin's NoRoute, which arrives with the
	// status already set to 404. The shell is a successful response and must say so.
	rec := httptest.NewRecorder()
	rec.Code = http.StatusNotFound

	spa.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/signin", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}
}

func TestRejectsTraversal(t *testing.T) {
	t.Parallel()

	spa := newTestSPA(t, bundle())

	// A traversal attempt must fall through to the shell, never escape the bundle.
	rec := get(t, spa, "/../../go.mod")
	if rec.Body.String() != indexBody {
		t.Fatalf("body = %q, want the shell", rec.Body.String())
	}
}

func TestHeadSkipsTheBody(t *testing.T) {
	t.Parallel()

	spa := newTestSPA(t, bundle())

	rec := httptest.NewRecorder()
	spa.ServeHTTP(rec, httptest.NewRequest(http.MethodHead, "/signin", nil))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusOK)
	}

	if rec.Body.Len() != 0 {
		t.Fatalf("body = %q, want empty", rec.Body.String())
	}
}
