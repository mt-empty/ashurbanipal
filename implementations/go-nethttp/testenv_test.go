package ashurbanipal

import (
	"os"
	"testing"
)

// requireTestEnv returns the named database URL. A missing one skips the
// test locally but fails it under CI, so a CI job that loses the variable
// can't turn its tests into silent skips.
func requireTestEnv(t *testing.T, name string) string {
	t.Helper()
	if v := os.Getenv(name); v != "" {
		return v
	}
	if os.Getenv("CI") != "" {
		t.Fatalf("%s is not set; CI must provide it", name)
	}
	t.Skipf("%s not set (the devcontainer sets it automatically)", name)
	return ""
}
