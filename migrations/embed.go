// Package migrations carries the schema history as data rather than as files on a disk.
//
// The server ships as one binary with the frontend already inside it, and the image it runs
// in is distroless: there is no shell in it to run a migration tool with, and no obvious
// place to mount this directory. Embedding keeps the deployment one artefact — the same
// reason internal/web embeds the bundle.
package migrations

import "embed"

// FS holds every migration in this directory, in the pairs golang-migrate expects.
//
//go:embed *.sql
var FS embed.FS
