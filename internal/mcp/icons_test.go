package mcp

import (
	"os"
	"regexp"
	"slices"
	"testing"
)

// The icon set is written twice: once here, because the connector validates what it writes,
// and once in the frontend, because that is what draws it. Two lists that drift leave a
// connector storing icons nothing renders — visible to nobody, since a missing icon looks
// exactly like an icon nobody set.
func TestIconsMatchTheFrontend(t *testing.T) {
	const source = "../../web/src/ui/Icon.tsx"

	raw, err := os.ReadFile(source)
	if err != nil {
		t.Fatalf("read %s: %v", source, err)
	}

	block := regexp.MustCompile(`(?s)export const ICON_NAMES = \[(.*?)\] as const;`).FindSubmatch(raw)
	if block == nil {
		t.Fatalf("ICON_NAMES is not where this test expects it in %s", source)
	}

	var front []string
	for _, match := range regexp.MustCompile(`'([^']+)'`).FindAllSubmatch(block[1], -1) {
		front = append(front, string(match[1]))
	}

	if len(front) == 0 {
		t.Fatal("read no icon names out of the frontend")
	}

	for _, name := range front {
		if !slices.Contains(Icons, name) {
			t.Errorf("the frontend draws %q and this package would refuse it", name)
		}
	}

	for _, name := range Icons {
		if !slices.Contains(front, name) {
			t.Errorf("this package accepts %q and the frontend cannot draw it", name)
		}
	}
}
